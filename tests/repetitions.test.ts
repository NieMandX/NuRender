import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {cube} from '../src/scene.ts';
import {findFamilies,worldPositions,POSITION_TOLERANCE,type RepetitionReport} from '../src/repetitions.ts';
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function fixture(){
 const c=cube(),v:number[]=[],idx:number[]=[];
 for(let copy=0;copy<4;copy++){
  const base=v.length/10;
  for(let i=0;i<c.vertices.length;i+=6)v.push(c.vertices[i]+copy*4,c.vertices[i+1],c.vertices[i+2],...c.vertices.slice(i+3,i+6),.5,.6,.7,0);
  // Reverse triangle order and cyclically rotate corners in alternating copies.
  const tris=Array.from({length:c.indices.length/3},(_,t)=>Array.from(c.indices.slice(t*3,t*3+3)));
  if(copy%2)tris.reverse();for(const t of tris)idx.push(...(copy%2?[t[1],t[2],t[0]]:t).map(i=>i+base));
 }
 return {v:new Float32Array(v),i:new Uint32Array(idx),verticesPerCopy:c.vertices.length/6};
}
test('discovers translated flat-shaded components despite index ordering; does not mutate input',()=>{
 const {v,i}=fixture(),before=v.slice(),r=findFamilies(v,i,identity,0,'fixture');
 assert.equal(r.parts.length,4);assert.equal(r.families.length,1);assert.equal(r.families[0].copies,4);assert.equal(r.families[0].maxErrorMetres,0);assert.deepEqual(v,before);
});
test('rejects changed geometry, materials and reversed winding',()=>{
 for(const kind of ['shape','material','winding']){
  const {v,i,verticesPerCopy}=fixture(),base=3*verticesPerCopy;
  if(kind==='shape')v[base*10]+=.01;
  if(kind==='material')for(let n=base;n<base+verticesPerCopy;n++)v[n*10+6]=.9;
  if(kind==='winding')for(let t=i.length*3/4;t<i.length;t+=3)[i[t],i[t+1]]=[i[t+1],i[t]];
  const r=findFamilies(v,i,identity,0,'fixture');assert.equal(r.families.length,1,kind);assert.equal(r.families[0].copies,3,kind);
 }
});
test('less than three copies are not accepted',()=>{
 const {v,i,verticesPerCopy}=fixture();assert.equal(findFamilies(v.slice(0,verticesPerCopy*20),i.slice(0,i.length/2),identity,0,'fixture').families.length,0);
});
test('real report matches source digest, independent corner verification, labels and complete accounting', {skip:process.env.NUR_ASSET_TESTS==='0'}, async()=>{
 const root=new URL('../public/scenes/m8-fragment/',import.meta.url),raw=await readFile(new URL('scene.json',root));
 const manifest=JSON.parse(raw.toString()),r:RepetitionReport=JSON.parse(await readFile(new URL('repetitions.json',root),'utf8'));
 const hash=createHash('sha256').update(raw);let repeated=0,analysed=0,excluded=0;
 for(const [gi,g] of manifest.groups.entries()){
  const vb=await readFile(new URL(g.vertices,root)),ib=await readFile(new URL(g.indices,root));hash.update(vb).update(ib);
  const v=new Float32Array(vb.buffer.slice(vb.byteOffset,vb.byteOffset+vb.byteLength)),idx=new Uint32Array(ib.buffer.slice(ib.byteOffset,ib.byteOffset+ib.byteLength));
  const lb=await readFile(new URL(r.groups[gi].labels,root)),labels=new Uint32Array(lb.buffer.slice(lb.byteOffset,lb.byteOffset+lb.byteLength));assert.equal(labels.length,g.vertexCount);
  const families=r.families.filter(f=>f.group===gi),expected=new Uint32Array(g.vertexCount),seen=new Set<number>();
  if(r.groups[gi].excluded){assert.equal(families.length,0);excluded+=g.indexCount/3*g.instances.length;}else analysed+=g.indexCount/3;
  const p=worldPositions(v,g.instances[0]);
  // Independently compare complete oriented triangle coordinates after applying
  // the report's translations. Sorting uses raw coordinates, not analyzer keys.
  const canonical=(member:typeof families[number]['members'][number])=>member.triangles.map(t=>{
    const corners=[0,1,2].map(k=>{const id=idx[t*3+k];return [...[0,1,2].map(a=>p[id*3+a]-member.translation[a]),...v.slice(id*10+3,id*10+10)];});
    const compare=(a:number[],b:number[])=>{for(let i=0;i<a.length;i++)if(Math.abs(a[i]-b[i])>1e-7)return a[i]-b[i];return 0;};
    let start=0;for(let k=1;k<3;k++)if(compare(corners[k],corners[start])<0)start=k;
    return [...corners[start],...corners[(start+1)%3],...corners[(start+2)%3]];
  }).sort((a,b)=>{for(let i=0;i<a.length;i++)if(Math.abs(a[i]-b[i])>1e-7)return a[i]-b[i];return 0;});
  for(const f of families){assert.ok(f.copies>=3);assert.equal(f.members.length,f.copies);const template=canonical(f.members[0]);
    for(const member of f.members){assert.equal(member.triangles.length,f.trianglesPerCopy);const candidate=canonical(member);for(let t=0;t<template.length;t++)for(let k=0;k<3;k++){
      let d2=0;for(let a=0;a<3;a++)d2+=(candidate[t][k*10+a]-template[t][k*10+a])**2;assert.ok(Math.sqrt(d2)<=POSITION_TOLERANCE+1e-9);
      for(let a=3;a<10;a++)assert.ok(Math.abs(candidate[t][k*10+a]-template[t][k*10+a])<=1e-4);
    }
    for(const t of member.triangles){assert.ok(t>=0&&t<g.indexCount/3);assert.ok(!seen.has(t));seen.add(t);repeated++;for(let k=0;k<3;k++)expected[idx[t*3+k]]=f.id;}
  }}
  assert.deepEqual(labels,expected);
 }
 assert.equal(hash.digest('hex'),r.sourceDigest);assert.equal(repeated,r.summary.repeatedTriangles);assert.equal(analysed,r.summary.analysedTriangles);assert.equal(excluded,r.summary.excludedTriangles);assert.equal(analysed+excluded,manifest.triangles);assert.equal(repeated/analysed,r.summary.coverage);
});

test('diagnostic GPU uploads change only RGB and restore original buffer bytes',{skip:process.env.NUR_ASSET_TESTS==='0'},async()=>{
 const {RealScene}=await import('../src/real-scene.ts');
 const priorFetch=globalThis.fetch,priorUsage=globalThis.GPUBufferUsage;
 let tamper=false;const allocated:{destroyed:boolean}[]=[];
 globalThis.GPUBufferUsage={VERTEX:32,INDEX:16,COPY_DST:8,STORAGE:128} as typeof GPUBufferUsage;
 globalThis.fetch=async (input)=>{
  const path=String(input);assert.ok(path.startsWith('/scenes/m8-fragment/'));
  const data=await readFile(new URL('../public'+path,import.meta.url));
  if(tamper&&path.endsWith('repetitions.json')){const r=JSON.parse(data.toString());r.sourceDigest='stale';return new Response(JSON.stringify(r));}
  return new Response(data);
 };
 const device={createBuffer:({size}:{size:number})=>{const buffer={size,data:new Uint8Array(size),destroyed:false,destroy(){this.destroyed=true;}};allocated.push(buffer);return buffer;},queue:{writeBuffer(buffer:{data:Uint8Array},offset:number,input:ArrayBuffer|ArrayBufferView){const bytes=ArrayBuffer.isView(input)?new Uint8Array(input.buffer,input.byteOffset,input.byteLength):new Uint8Array(input);buffer.data.set(bytes,offset);}}};
 let scene:InstanceType<typeof RealScene>|undefined;
 try{
  scene=await RealScene.load(device as unknown as GPUDevice);await scene.loadAnalysis();
  const allGroups=[...new Set([...scene.groups,...scene.structured])];
  const snapshots=allGroups.map(g=>(g.vertices as unknown as {data:Uint8Array}).data.slice());
  scene.setDiagnostic(-1);let changes=0;
  for(const [i,g] of allGroups.entries()){
   const old=new Float32Array(snapshots[i].buffer),now=new Float32Array((g.vertices as unknown as {data:Uint8Array}).data.buffer);
   for(let k=0;k<old.length;k++){if(k%10>=6&&k%10<=8){if(old[k]!==now[k])changes++;}else assert.equal(now[k],old[k]);}
  }
  assert.ok(changes>0);scene.setDiagnostic(31);scene.setDiagnostic(0);
  for(const [i,g] of allGroups.entries())assert.deepEqual((g.vertices as unknown as {data:Uint8Array}).data,snapshots[i]);
  for(const batching of [false,true]){
   scene.batching=batching;let calls=0,triangles=0;
   const pass={setVertexBuffer(){},setIndexBuffer(){},setBindGroup(){},drawIndexed(count:number,instances=1){calls++;triangles+=count/3*instances;}};
   scene.draw(pass as unknown as GPURenderPassEncoder,'B');if(batching)scene.drawBatch(pass as unknown as GPURenderPassEncoder);
   assert.equal(calls,batching?40:scene.legacyDrawGroups);assert.equal(triangles,scene.manifest.triangles);
  }
  const materialIdentity=scene.materialIdentity;
  assert.equal(materialIdentity.layoutDigest,'eb6b3173cefa7de74a09922fe4097d12199be931789382ce978c43ad72e1104d','0.7 and 0.8 packs remain compatible');
  scene.editMaterial(31,null,[.6,.4,.1],0,.8,1);scene.editMaterial(31,0,[.1,.2,.7],.5,.1,0);
  const materialPack=JSON.parse(JSON.stringify(scene.exportMaterials()));
  const gpuData=()=>allocated.map(b=>(b as unknown as {data:Uint8Array}).data.slice());
  const editedGpu=gpuData();
  assert.throws(()=>scene!.importMaterials({...materialPack,sourceDigest:'wrong'}),/другой геометрии/);
  assert.throws(()=>scene!.importMaterials({...materialPack,layoutDigest:'wrong'}),/Разбор элементов/);
  assert.deepEqual(gpuData(),editedGpu,'rejected import must leave every GPU buffer intact');
  scene.resetMaterials();assert.equal(scene.materialEdits,0);
  assert.equal(scene.importMaterials(materialPack),40);
  assert.deepEqual(gpuData(),editedGpu,'import must upload exactly the previous material and element bytes');
  assert.deepEqual(scene.materialIdentity,materialIdentity,'edits do not change the layout digest');
  scene.destroy();assert.ok(allocated.every(b=>b.destroyed));tamper=true;
  await assert.rejects(()=>RealScene.load(device as unknown as GPUDevice),/Устаревший разбор/);
  assert.ok(allocated.every(b=>b.destroyed),'failed loading must free uploaded buffers');
 }finally{scene?.destroy();globalThis.fetch=priorFetch;globalThis.GPUBufferUsage=priorUsage;}
});
