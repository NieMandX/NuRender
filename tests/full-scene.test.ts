import {frustumPlanes} from '../src/frustum.ts';
import {mat4} from 'wgpu-matrix';
import {MeshoptEncoder} from 'meshoptimizer';
import {compactMobile} from '../scripts/mobile-codec.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {packFullChunks,FullScene,FULL_ROOT,type FullChunk,type FullPart,type FullManifest} from '../src/full-scene.ts';
import {sourceDigest} from '../src/structured-real.ts';
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1,1,0,0,0,0,1,0,0,0,0,1,0];
function chunk(family:number,copies:number):FullChunk{
 const vertices=new Float32Array([0,0,0,0,0,1,0,0,1,0,0,0,0,1,1,0,1,1,0,0,0,1,1,1,0,1,0,0,0,1,0,1]);
 const indices=new Uint32Array([0,1,2,0,2,3]),elements=new Float32Array(copies*36);
 const instances=Array.from({length:copies},(_,i)=>{const m=identity.slice();m[12]=family*10+i*2;elements.set(m,i*36);return m;});
 return {vertices,indices,elements,ids:Array.from({length:copies},(_,i)=>i+1),meta:{name:'sample',family,material:1,color:[.5,.5,.5],vertices:'part-0.vertices.bin',indices:'part-0.indices.bin',vertexCount:4,indexCount:6,vertexDigest:'',indexDigest:'',instances,objects:Array.from({length:copies},(_,i)=>'object '+family+'/'+i)}};
}
test('full batches decode every source corner, UV and instance transform without geometry copies',()=>{
 const chunks=[chunk(1,1),chunk(2,3)],p=packFullChunks(chunks);let address=0,element=0;
 for(const c of chunks){for(let copy=0;copy<c.meta.instances.length;copy++){
   for(const old of c.indices){const a=p.addresses[address++],at=(a&65535)*8;assert.equal(a>>>16,element);assert.deepEqual(p.vertices.subarray(at,at+8),c.vertices.subarray(old*8,old*8+8));}
   assert.deepEqual(p.elements.subarray(element*36,element*36+36),c.elements.subarray(copy*36,copy*36+36));element++;
 }}
 assert.equal(p.indices.length,12);assert.equal(p.addresses.length,24);assert.equal(p.vertices.byteLength,8*32);
 assert.throws(()=>packFullChunks([{...chunks[0],meta:{...chunks[0].meta,vertexCount:65537}}]),/16-bit/);
});
for(const mobile of [false,true])test(`full loader ${mobile?'mobile':'desktop'} keeps A/C immutable, applies overrides and frees resources`,async()=>{
 await MeshoptEncoder.ready;
 const chunks=[chunk(1,1),chunk(2,2),chunk(2,2)],files=new Map<string,Uint8Array>();
 for(const [i,c] of chunks.entries()){
   c.meta.vertices=`part-${i}.vertices.bin`;c.meta.indices=`part-${i}.indices.bin`;c.meta.vertexDigest=await sourceDigest([new Uint8Array(c.vertices.buffer)]);c.meta.indexDigest=await sourceDigest([new Uint8Array(c.indices.buffer)]);
   c.meta.objects=c.meta.family===1?['Glass']:['Стекло Стемалит Светлый','Metal Aluminum'];
   files.set(c.meta.vertices,new Uint8Array(c.vertices.buffer));files.set(c.meta.indices,new Uint8Array(c.indices.buffer));
   if(mobile){const p=compactMobile(c.vertices,c.indices,c.meta.instances);c.meta.instances=p.instances;c.meta.vertexCount=p.count;
     const v=MeshoptEncoder.encodeVertexBuffer(p.vertices,p.count,20),i=MeshoptEncoder.encodeIndexBuffer(new Uint8Array(p.indices.buffer),p.indices.length,2);files.set(c.meta.vertices,v);files.set(c.meta.indices,i);c.meta.vertexDigest=await sourceDigest([v]);c.meta.indexDigest=await sourceDigest([i]);}
 }
 const manifest={version:2,vertexFormat:mobile?'unorm16x4-snorm8x4-float32x2':undefined,compression:mobile?'meshopt':undefined,name:'test',source:'test.blend',anchorObject:'centre',cropRule:'none',materials:'PBR',bounds:[[0,0,0],[1,1,1]],groups:chunks.map(c=>c.meta),families:[{id:1},{id:2}],objects:[{name:'all',triangles:10}],triangles:10};
 const raw=new TextEncoder().encode(JSON.stringify(manifest)),digest=await sourceDigest([raw]);files.set('scene.json',raw);files.set('textures.json',new TextEncoder().encode(JSON.stringify({version:1,sourceDigest:digest,groups:[],images:[],materials:[{name:'',roughness:.5,metallic:0,maps:{}}],warnings:[]})));
 const oldFetch=globalThis.fetch,oldUsage=globalThis.GPUBufferUsage;const buffers:{data:Uint8Array;destroyed:boolean}[]=[];
 globalThis.GPUBufferUsage={VERTEX:32,INDEX:16,COPY_DST:8,STORAGE:128} as typeof GPUBufferUsage;
 globalThis.fetch=async input=>new Response(files.get(String(input).replace(mobile?'/scenes/m8-mobile/':FULL_ROOT,''))!);
 const device={createBuffer:({size}:{size:number})=>{const b={size,data:new Uint8Array(size),destroyed:false,destroy(){this.destroyed=true;}};buffers.push(b);return b;},queue:{onSubmittedWorkDone:async()=>{},writeBuffer(b:{data:Uint8Array},offset:number,data:ArrayBufferView){b.data.set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength),offset);}}};
 let scene:FullScene|undefined;
 try{
   scene=await FullScene.load(device as unknown as GPUDevice,undefined,mobile);assert.equal(scene.classification.length,3);assert.equal(scene.classification[1].materials[0].classification.kind,'stemolit');assert.equal(scene.classification[1].materials[0].triangles,4);assert.equal(scene.elementCount,5);assert.equal(Object.values(scene.allocationBreakdown).reduce((a,b)=>a+b,0),scene.residentBytes);
   const base=scene.batches.map(b=>b.base.slice());assert.equal(scene.shadowVersion,0);assert.equal(scene.editMaterial(2,0,[.3,.4,.5],.2,.1,1),2);assert.equal(scene.shadowVersion,1);scene.editMaterial(2,0,[.8,.1,.2],.1,.5,0);assert.equal(scene.shadowVersion,1);
   assert.deepEqual(scene.batches.map(b=>b.base),base);const edited=mobile?scene.batches[1].edited:scene.batches[0].edited;assert.equal(edited[(mobile?0:36)+19],0);assert.equal(edited[(mobile?36:72)+19],3);
   if(mobile)assert.equal(scene.allocationBreakdown.BAddresses,0);
   const pack=scene.exportMaterials();scene.resetMaterials();assert.equal(scene.shadowVersion,2);assert.equal(scene.materialEdits,0);assert.equal(scene.importMaterials(pack),2);assert.equal(scene.shadowVersion,3);
   assert.throws(()=>scene!.importMaterials({...pack,sourceDigest:'bad'}));assert.equal(scene.materialEdits,2);
   for(const mode of ['A','B','C'] as const){let calls=1;const pass={setBindGroup(){},setIndexBuffer(){},setVertexBuffer(){},drawIndexed(){calls++;}};for(const layer of ['shadow','opaque','glass'] as const)scene.draw(pass as unknown as GPURenderPassEncoder,mode,layer);assert.equal(calls,scene.drawCount(mode));}
   const coldBefore=scene.drawCount('B')-scene.drawCount('B',false);
   scene.prepareVisibility(frustumPlanes(mat4.identity()));assert.equal(scene.cullingInfo.rejectedInstances,scene.elementCount);assert.equal(scene.drawCount('B',false),1);assert.equal(scene.drawCount('B')-scene.drawCount('B',false),coldBefore);
   const cachedVisibility=scene.cullingInfo;scene.prepareVisibility(frustumPlanes(mat4.identity()));assert.equal(scene.cullingInfo,cachedVisibility);
   scene.prepareVisibility(null);assert.equal(scene.cullingInfo.rejectedInstances,0);
   scene.prepareVisibility(frustumPlanes(mat4.identity()));assert.equal(scene.cullingInfo.rejectedInstances,scene.elementCount);
   scene.prepareVisibility(null);
   scene.destroy();assert.ok(buffers.every(b=>b.destroyed));
   files.set(chunks[0].meta.vertices,new Uint8Array([99]));
   await assert.rejects(()=>FullScene.load(device as unknown as GPUDevice,undefined,mobile),/Повреждена/);assert.ok(buffers.every(b=>b.destroyed));
 }finally{scene?.destroy();globalThis.fetch=oldFetch;globalThis.GPUBufferUsage=oldUsage;}
});
test('complete Blender export preserves all 16,988,989 triangles and bounds every upload', {skip:process.env.NUR_ASSET_TESTS==='0'}, async()=>{
 const root=new URL('../public/scenes/m8-full/',import.meta.url),raw=await readFile(new URL('scene.json',root)),manifest:FullManifest=JSON.parse(raw.toString());
 const textures=JSON.parse(await readFile(new URL('textures.json',root),'utf8'));assert.equal(textures.sourceDigest,await sourceDigest([raw]));
 assert.equal(manifest.objects.length,265);assert.equal(manifest.triangles,16988989);assert.equal(manifest.groups.reduce((n,g)=>n+g.indexCount/3*g.instances.length,0),manifest.triangles);
 let bytes=0;
 for(const g of manifest.groups){
   assert.ok(g.vertexCount<=65536);assert.ok(g.material>=1&&g.material<=textures.materials.length);
   const [v,i]=await Promise.all([readFile(new URL(g.vertices,root)),readFile(new URL(g.indices,root))]);bytes+=v.length+i.length;
   assert.equal(v.length,g.vertexCount*32);assert.equal(i.length,g.indexCount*4);assert.equal(await sourceDigest([v]),g.vertexDigest);assert.equal(await sourceDigest([i]),g.indexDigest);
   const indices=new Uint32Array(i.buffer,i.byteOffset,i.length/4);assert.ok(indices.every(index=>index<g.vertexCount));
 }
 assert.equal(bytes,1294003996);
});
