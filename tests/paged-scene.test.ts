import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MeshoptDecoder as D} from 'meshoptimizer';
import {FullScene,type FullManifest} from '../src/full-scene.ts';
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
// Meshopt may cyclically rotate triangle corners; winding and all attributes stay fixed.
const triangleHash=(v:Uint8Array,i:Uint16Array,n:number)=>{
 const c=[0,1,2].map(k=>Buffer.from(v.subarray(i[n+k]*20,i[n+k]*20+20)).toString('hex'));
 return [0,1,2].map(k=>c[k]+c[(k+1)%3]+c[(k+2)%3]).sort()[0];
};
const root=new URL('../public/scenes/m8-paged/',import.meta.url);
const skip=process.env.NUR_ASSET_TESTS==='0';
test('paged export keeps all objects and exact reference triangles; verifies every buffer and page bound',{skip},async()=>{
 await D.ready;const raw=await readFile(new URL('scene.json',root)),m:FullManifest=JSON.parse(raw.toString());
 const baseRaw=await readFile(new URL('../m8-mobile/scene.json',root)),base:FullManifest=JSON.parse(baseRaw.toString());
 assert.equal(m.paging?.sourceDigest,hash(baseRaw));assert.equal(m.paging?.referenceTriangles,base.triangles);
 assert.deepEqual(m.objects.map(o=>o.name),base.objects.map(o=>o.name));
 const texture=JSON.parse(await readFile(new URL('textures.json',root),'utf8'));assert.equal(texture.sourceDigest,hash(raw));
 const preparation=JSON.parse(await readFile(new URL('preparation.json',root),'utf8'));
 const parent=new Map<number,number>(preparation.stats.map((r:{page:number;sourcePart:number})=>[r.page,r.sourcePart]));
 const reference=new Map<number,string[]>();let fineTriangles=0,coarseTriangles=0;
 for(const [id,g] of m.groups.entries()){
  fineTriangles+=(g.detail?.indexCount??g.indexCount)/3*g.instances.length;coarseTriangles+=g.indexCount/3*g.instances.length;
  for(const [at,meta] of (g.detail?[g,g.detail]:[g]).entries()){
   const [vb,ib]=await Promise.all([readFile(new URL(meta.vertices,root)),readFile(new URL(meta.indices,root))]);assert.equal(hash(vb),meta.vertexDigest);assert.equal(hash(ib),meta.indexDigest);
   const v=new Uint8Array(meta.vertexCount*20),i=new Uint16Array(meta.indexCount);D.decodeVertexBuffer(v,meta.vertexCount,20,vb);D.decodeIndexBuffer(new Uint8Array(i.buffer),meta.indexCount,2,ib);assert.ok(i.every(n=>n<meta.vertexCount));
   if(g.bounds){const d=new DataView(v.buffer);for(let n=0;n<meta.vertexCount;n++)for(let a=0;a<3;a++){const p=d.getUint16(n*20+a*2,true)/65535;assert.ok(p>=g.bounds[0][a]&&p<=g.bounds[1][a]);}}
   // Hash oriented triangles including every packed attribute, independently
   // of page-local indices. Only one source part is checked per selected sample.
   const source=parent.get(id);
   if(source!==undefined&&[546,666,818,878].includes(source)&&at===(g.detail?1:0)){
    assert.deepEqual(g.instances,base.groups[source].instances);
    const triangles=reference.get(source)??[];for(let n=0;n<i.length;n+=3)triangles.push(triangleHash(v,i,n));reference.set(source,triangles);
   }
  }
 }
 assert.equal(fineTriangles,base.triangles);assert.equal(coarseTriangles,m.triangles);assert.equal(m.objects.reduce((n,o)=>n+o.triangles,0),m.triangles);
 for(const [source,triangles] of reference){const g=base.groups[source],v=new Uint8Array(g.vertexCount*20),i=new Uint16Array(g.indexCount);
  D.decodeVertexBuffer(v,g.vertexCount,20,await readFile(new URL('../m8-mobile/'+g.vertices,root)));D.decodeIndexBuffer(new Uint8Array(i.buffer),g.indexCount,2,await readFile(new URL('../m8-mobile/'+g.indices,root)));
  const original=[];for(let n=0;n<i.length;n+=3)original.push(triangleHash(v,i,n));assert.deepEqual(triangles.sort(),original.sort());
 }
 assert.equal(reference.size,4);
});

test('GPU paging replaces visible geometry only, preserves shadow geometry and material edits, then frees buffers',{skip},async()=>{
 const raw=await readFile(new URL('scene.json',root)),all:FullManifest=JSON.parse(raw.toString()),sourceId=all.groups.findIndex(g=>g.detail),g=all.groups[sourceId];
 const m={...all,groups:[g],triangles:g.indexCount/3,objects:[{name:g.objects[0],triangles:g.indexCount/3}]};
 const bytes=Buffer.from(JSON.stringify(m)),textures=JSON.parse(await readFile(new URL('textures.json',root),'utf8'));textures.sourceDigest=hash(bytes);
 const oldFetch=globalThis.fetch,oldUsage=globalThis.GPUBufferUsage,buffers:{size:number;data:Uint8Array;destroyed:boolean;destroy():void}[]=[];
 globalThis.GPUBufferUsage={VERTEX:32,INDEX:16,COPY_DST:8,STORAGE:128} as typeof GPUBufferUsage;
 let tamper=false;
 globalThis.fetch=async input=>{const path=String(input).split('/').at(-1)!;return new Response(tamper&&path.startsWith('detail-')?new Uint8Array([0]):path==='scene.json'?bytes:path==='textures.json'?JSON.stringify(textures):await readFile(new URL(path,root)));};
 const device={createBuffer:({size}:{size:number})=>{const b={size,data:new Uint8Array(size),destroyed:false,destroy(){this.destroyed=true;}};buffers.push(b);return b;},queue:{onSubmittedWorkDone:async()=>{},writeBuffer(b:{data:Uint8Array},offset:number,d:ArrayBufferView){b.data.set(new Uint8Array(d.buffer,d.byteOffset,d.byteLength),offset);}}};
 let scene:FullScene|undefined;
 try{
  scene=await FullScene.load(device as unknown as GPUDevice,undefined,true,true);const initial=scene.residentBytes,bound=scene.batches[0].bounds[0],center=bound[0].map((v,a)=>(v+bound[1][a])/2),eye=center.map((v,a)=>v+(a===2?1:0));
  const draw=(shadow=false)=>{let count=0;const p={setBindGroup(){},setIndexBuffer(){},setVertexBuffer(){},drawIndexed(n:number){count+=n;}};scene!.draw(p as unknown as GPURenderPassEncoder,'B',shadow?'shadow':'opaque');return count;};
  const shadowBefore=draw(true),shadowStamp=scene.bundleStamp(true),oldStamp=scene.bundleStamp(false);scene.prepareDetail(eye,center,1000,[]);
  for(let i=0;i<100&&scene.pagingInfo!.pendingPages;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(scene.bundleStamp(true),shadowStamp);assert.notEqual(scene.bundleStamp(false),oldStamp);assert.equal(scene.pagingInfo?.residentPages,1);assert.equal(draw(),g.detail!.indexCount);assert.equal(draw(true),shadowBefore);assert.equal(scene.residentBytes,initial+g.detail!.bytes);
  assert.equal(Object.values(scene.allocationBreakdown).reduce((a,b)=>a+b,0),scene.residentBytes);
  scene.editMaterial(g.family,null,[1,0,0],0,.5,1);assert.deepEqual(Array.from(scene.batches[0].edited.slice(28,31)),[1,0,0]);assert.equal(draw(),g.detail!.indexCount);
  scene.detailEnabled=false;scene.prepareDetail(eye,center,1000,[]);assert.equal(scene.pagingInfo?.residentPages,0);assert.equal(scene.residentBytes,initial);assert.equal(draw(),g.indexCount);assert.equal(draw(true),shadowBefore);
  scene.destroy();assert.ok(buffers.every(b=>b.destroyed));
  tamper=true;scene=await FullScene.load(device as unknown as GPUDevice,undefined,true,true);const fallbackBytes=scene.residentBytes;scene.prepareDetail(eye,center,1000,[]);
  for(let i=0;i<100&&scene.pagingInfo!.pendingPages;i++)await new Promise(r=>setTimeout(r,5));
  assert.equal(scene.pagingInfo?.failedPages,1);assert.equal(scene.pagingInfo?.residentPages,0);assert.equal(scene.residentBytes,fallbackBytes);assert.equal(draw(),g.indexCount);
  scene.destroy();assert.ok(buffers.every(b=>b.destroyed));
 }finally{scene?.destroy();globalThis.fetch=oldFetch;globalThis.GPUBufferUsage=oldUsage;}
});
