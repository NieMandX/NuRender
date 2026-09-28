import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MeshoptDecoder as D} from 'meshoptimizer';
import {FullScene,type FullManifest} from '../src/full-scene.ts';
import {validatePackRanges,slicePack} from '../src/stream-layout.ts';
const root=new URL('../public/scenes/m8-stream/',import.meta.url),skip=process.env.NUR_ASSET_TESTS==='0';
const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const triangle=(v:Uint8Array,i:Uint16Array,n:number)=>{const c=[0,1,2].map(k=>Buffer.from(v.subarray(i[n+k]*20,i[n+k]*20+20)).toString('hex'));return [0,1,2].map(k=>c[k]+c[(k+1)%3]+c[(k+2)%3]).sort()[0];};
test('all-scene packs retain every object and finest mobile triangle, and every level is valid',{skip},async()=>{
 await D.ready;const raw=await readFile(new URL('scene.json',root)),m:FullManifest=JSON.parse(raw.toString()),sourceRaw=await readFile(new URL('../m8-mobile/scene.json',root)),source:FullManifest=JSON.parse(sourceRaw.toString());
 assert.equal(m.paging?.sourceDigest,hash(sourceRaw));assert.deepEqual(m.objects.map(o=>o.name),source.objects.map(o=>o.name));
 const pack=await readFile(new URL('bootstrap.bin',root)),data=Uint8Array.from(pack).buffer;
 assert.equal(hash(pack),m.paging?.bootstrap?.sha256);validatePackRanges(m.groups,pack.length);
 const preparation=JSON.parse(await readFile(new URL('preparation.json',root),'utf8')),parents=new Map<number,number>(preparation.stats.map((p:{page:number;sourcePart:number})=>[p.page,p.sourcePart]));
 const samples=[0,5,666,878],actual=new Map<number,string[]>();let total=0,baseBytes=0;
 for(const [id,g] of m.groups.entries()){
  const levels=g.levels??[],metas=[g,...levels];total+=metas.at(-1)!.indexCount/3*g.instances.length;baseBytes+=g.vertexCount*20+Math.ceil(g.indexCount*2/4)*4;
  for(const [level,d] of metas.entries()){
   let pair:ReturnType<typeof slicePack>;
   if(level===0)pair=slicePack(data,g.packed!);
   else{const p=levels[level-1].packet!,bytes=await readFile(new URL(p.file,root));assert.equal(bytes.length,p.bytes);assert.equal(hash(bytes),p.sha256);pair=slicePack(Uint8Array.from(bytes).buffer,{offset:0,vertexBytes:p.vertexBytes,indexBytes:p.bytes-p.vertexBytes});}
   assert.equal(hash(new Uint8Array(pair.vb)),d.vertexDigest);assert.equal(hash(new Uint8Array(pair.ib)),d.indexDigest);
   const v=new Uint8Array(d.vertexCount*20),i=new Uint16Array(d.indexCount);D.decodeVertexBuffer(v,d.vertexCount,20,new Uint8Array(pair.vb));D.decodeIndexBuffer(new Uint8Array(i.buffer),d.indexCount,2,new Uint8Array(pair.ib));assert.ok(i.every(n=>n<d.vertexCount));
   const view=new DataView(v.buffer);for(let n=0;n<d.vertexCount;n++)for(let a=0;a<3;a++){const p=view.getUint16(n*20+a*2,true)/65535;assert.ok(p>=g.bounds![0][a]&&p<=g.bounds![1][a]);}
   const parent=parents.get(id)!;
   if(samples.includes(parent)&&level===metas.length-1){assert.deepEqual(g.instances,source.groups[parent].instances);const a=actual.get(parent)??[];for(let n=0;n<i.length;n+=3)a.push(triangle(v,i,n));actual.set(parent,a);}
  }
 }
 assert.equal(total,source.triangles);assert.equal(m.objects.reduce((n,o)=>n+o.triangles,0),m.triangles);assert.ok(baseBytes<48*1024*1024);assert.equal(actual.size,samples.length);
 for(const [id,triangles] of actual){const g=source.groups[id],v=new Uint8Array(g.vertexCount*20),i=new Uint16Array(g.indexCount);D.decodeVertexBuffer(v,g.vertexCount,20,await readFile(new URL('../m8-mobile/'+g.vertices,root)));D.decodeIndexBuffer(new Uint8Array(i.buffer),g.indexCount,2,await readFile(new URL('../m8-mobile/'+g.indices,root)));const expected=[];for(let n=0;n<i.length;n+=3)expected.push(triangle(v,i,n));assert.deepEqual(triangles.sort(),expected.sort());}
});
test('startup fetches only overview; camera streams two refinements, keeps static shadows and releases buffers',{skip},async()=>{
 const all:FullManifest=JSON.parse(await readFile(new URL('scene.json',root),'utf8')),g=structuredClone(all.groups.find(g=>g.levels?.length===2&&g.instances.length===1)!);
 const packed=await readFile(new URL('bootstrap.bin',root)),r=g.packed!,single=packed.subarray(r.offset,r.offset+r.vertexBytes+r.indexBytes),base=Buffer.concat([single,single]);g.packed!.offset=0;
 const second=structuredClone(g);second.packed!.offset=single.length;second.color=[.2,.3,.4];
 const m={...all,groups:[g,second],triangles:g.indexCount*2/3,objects:[{name:g.objects[0],triangles:g.indexCount*2/3}],paging:{...all.paging!,bootstrap:{file:'bootstrap.bin',bytes:base.length,sha256:hash(base)}}};
 const raw=Buffer.from(JSON.stringify(m)),textures=JSON.parse(await readFile(new URL('textures.json',root),'utf8'));textures.sourceDigest=hash(raw);
 const oldFetch=globalThis.fetch,oldUsage=globalThis.GPUBufferUsage,requests:string[]=[],buffers:{size:number;data:Uint8Array;destroyed:boolean;destroy():void}[]=[];let corrupt=false;
 globalThis.GPUBufferUsage={VERTEX:32,INDEX:16,COPY_DST:8,STORAGE:128} as typeof GPUBufferUsage;
 globalThis.fetch=async input=>{const path=String(input).split('/').at(-1)!;requests.push(path);return new Response(path==='scene.json'?raw:path==='textures.json'?JSON.stringify(textures):path==='bootstrap.bin'?base:corrupt?new Uint8Array([0]):await readFile(new URL(path,root)));};
 const device={createBuffer:({size}:{size:number})=>{const b={size,data:new Uint8Array(size),destroyed:false,destroy(){this.destroyed=true;}};buffers.push(b);return b;},queue:{onSubmittedWorkDone:async()=>{},writeBuffer(b:{data:Uint8Array},offset:number,data:ArrayBufferView){b.data.set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength),offset);}}};let scene:FullScene|undefined;
 const settle=async()=>{for(let n=0;n<100&&scene!.pagingInfo!.pendingPages;n++)await new Promise(r=>setTimeout(r,5));assert.equal(scene!.pagingInfo!.pendingPages,0);};
 try{
  scene=await FullScene.load(device as unknown as GPUDevice,undefined,true,'stream');assert.deepEqual(requests,['scene.json','textures.json','bootstrap.bin']);const baseline=scene.residentBytes;
  assert.equal(buffers.length,4,'overview uses four shared buffers, not four per page');
  assert.equal(scene.batches[0].vertices,scene.batches[1].vertices);assert.equal(scene.batches[1].vertexOffset,g.vertexCount*20);assert.equal(scene.batches[1].indexOffset,Math.ceil(g.indexCount*2/4)*4);assert.equal(scene.batches[1].elementOffset,144);
  for(const b of scene.batches){const gpu=b.elements as unknown as {data:Uint8Array};assert.deepEqual(gpu.data.slice(b.elementOffset,b.elementOffset!+144),new Uint8Array(b.base.buffer));}
  assert.equal(Object.values(scene.allocationBreakdown).reduce((a,b)=>a+b,0),baseline);
  const bound=scene.batches[0].bounds[0],center=bound[0].map((v,a)=>(v+bound[1][a])/2),half=(bound[1][2]-bound[0][2])/2;
  const prepare=(factor:number)=>scene!.prepareDetail(center.map((v,a)=>v+(a===2?half+1000/(2*Math.tan(.65/2))/factor:0)),center,1000,[]);
  const draws=(shadow=false)=>{let triangles=0;scene!.draw({setVertexBuffer(){},setIndexBuffer(){},drawIndexed(n:number,copies:number){triangles+=n/3*copies;}} as unknown as GPURenderPassEncoder,'B',shadow?'shadow':'opaque');return triangles;};
  const shadow=draws(true),stamp=scene.bundleStamp(true);
  prepare(1.2/g.levels![0].errorWorld);await settle();assert.deepEqual(scene.pagingInfo!.activeLevels,[0,2,0]);assert.equal(draws(),g.levels![0].indexCount*2/3);
  prepare(2/g.levels![1].errorWorld);await settle();assert.deepEqual(scene.pagingInfo!.activeLevels,[0,0,2]);assert.equal(draws(),g.levels![1].indexCount*2/3);assert.equal(draws(true),shadow);assert.equal(scene.bundleStamp(true),stamp);assert.ok(scene.pagingInfo!.peakBytes<=48*1024*1024);
  scene.editMaterial(g.family,null,[1,0,0],0,.3,1);assert.deepEqual([...scene.batches[0].edited.slice(28,31)],[1,0,0]);
  for(const b of scene.batches){const gpu=b.overrides as unknown as {data:Uint8Array};assert.deepEqual(gpu.data.slice(b.elementOffset,b.elementOffset!+144),new Uint8Array(b.edited.buffer));}
  scene.detailEnabled=false;prepare(1000);assert.equal(scene.residentBytes,baseline);assert.equal(draws(),g.indexCount*2/3);assert.equal(draws(true),shadow);
  corrupt=true;scene.detailEnabled=true;prepare(1000);await settle();assert.equal(scene.pagingInfo!.failedPages,2);assert.equal(scene.residentBytes,baseline);assert.equal(draws(),g.indexCount*2/3);
  scene.destroy();assert.ok(buffers.every(b=>b.destroyed));
 }finally{scene?.destroy();globalThis.fetch=oldFetch;globalThis.GPUBufferUsage=oldUsage;}
});
