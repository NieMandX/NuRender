import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {packGroup} from '../src/structured-real.ts';
import {components,type RepetitionReport} from '../src/repetitions.ts';
import {classifyVertices} from '../src/material-classification.ts';
if(process.env.NUR_ASSET_TESTS==='0'){
 test('structured-real integration requires exported model assets',{skip:true},()=>{});
}else{
const root=new URL('../public/scenes/m8-fragment/',import.meta.url);
const manifest=JSON.parse(await readFile(new URL('scene.json',root),'utf8'));
const report:RepetitionReport=JSON.parse(await readFile(new URL('repetitions.json',root),'utf8'));
const provenance=JSON.parse(await readFile(new URL('materials.json',root),'utf8'));
const f32=Math.fround;
// Separate float32 operations conservatively model the shader's matrix product;
// the GPU may use fused operations, so image readback remains the final check.
function world(v:Float32Array,id:number,m:ArrayLike<number>){return [0,1,2].map(a=>f32(f32(f32(f32(m[a]*v[id*10])+f32(m[4+a]*v[id*10+1]))+f32(m[8+a]*v[id*10+2]))+m[12+a]));}
test('B reconstructs every accepted copy within 1 mm plus float32 error and preserves all residual attributes',async()=>{
 let triangles=0,maxError=0,baseBytes=0,bBytes=0,draws=0;
 for(const [gi,g] of manifest.groups.entries()){
  const vb=await readFile(new URL(g.vertices,root)),ib=await readFile(new URL(g.indices,root));
  const v=new Float32Array(vb.buffer.slice(vb.byteOffset,vb.byteOffset+vb.byteLength)),idx=new Uint32Array(ib.buffer.slice(ib.byteOffset,ib.byteOffset+ib.byteLength));
  const metadata=provenance.groups[gi],sb=await readFile(new URL(metadata.vertexSlots,root));
  classifyVertices(v,idx,new Uint32Array(sb.buffer.slice(sb.byteOffset,sb.byteOffset+sb.byteLength)),metadata.materialNames,g.objects);
  const families=report.families.filter(f=>f.group===gi),bytes=vb.byteLength+ib.byteLength+g.instances.length*112;baseBytes+=bytes;
  if(!families.length){bBytes+=bytes;triangles+=idx.length/3*g.instances.length;draws++;continue;}
  const packed=packGroup(v,idx,g.instances[0],families),parts=components(v,idx,g.instances[0]);
  const byFirstTriangle=new Map(parts.map(c=>[c.triangles[0],c]));
  const covered=new Set<number>();
  for(const mesh of packed){
   bBytes+=mesh.vertices.byteLength+mesh.indices.byteLength+mesh.instances.byteLength;triangles+=mesh.indices.length/3*mesh.instances.length/28;draws++;
   // Compact mesh must preserve every original template/residual triangle corner.
   const oldToNew=new Map<number,number>();
   for(const [j,t] of mesh.sourceTriangles.entries())for(let k=0;k<3;k++){
    const old=idx[t*3+k],id=mesh.indices[j*3+k];oldToNew.set(old,id);
    assert.deepEqual(mesh.vertices.slice(id*10,id*10+10),v.slice(old*10,old*10+10));
   }
   if(mesh.family===0){assert.deepEqual(mesh.instances,new Float32Array(g.instances[0]));for(const t of mesh.sourceTriangles){assert.ok(!covered.has(t));covered.add(t);}continue;}
   const f=families.find(f=>f.id===mesh.family)!,template=byFirstTriangle.get(f.members[0].triangles[0])!;
   for(const [j,member] of f.members.entries()){
    const target=byFirstTriangle.get(member.triangles[0])!,matrix=mesh.instances.subarray(j*28,(j+1)*28);
    assert.equal(target.canonical.length,template.canonical.length);
    for(let k=0;k<template.canonical.length;k++){
     const source=oldToNew.get(template.canonical[k])!,destination=target.canonical[k];
     const a=world(mesh.vertices,source,matrix),b=world(v,destination,new Float32Array(g.instances[0]));
     const error=Math.hypot(...a.map((x,i)=>x-b[i]));maxError=Math.max(error,maxError);assert.ok(error<=.0011,`family ${f.id}: ${error}`);
     for(let c=3;c<10;c++)assert.ok(Math.abs(mesh.vertices[source*10+c]-v[destination*10+c])<=1e-4);
    }
    for(const t of member.triangles){assert.ok(!covered.has(t));covered.add(t);}
   }
  }
  assert.equal(covered.size,idx.length/3);
 }
 assert.equal(triangles,manifest.triangles);assert.ok(bBytes<baseBytes);
 console.log(JSON.stringify({baseBytes,bBytes,drawsPerPass:draws,maxFloat32PositionErrorMetres:maxError,triangles}));
});
test('packer rejects overlapping families and invalid triangle IDs',()=>{
 const g=manifest.groups[0],f=report.families.find(f=>f.group===0)!;
 const v=new Float32Array(g.vertexCount*10),i=new Uint32Array(g.indexCount);
 assert.throws(()=>packGroup(v,i,g.instances[0],[f,f]),/Overlapping/);
 const bad=structuredClone(f);bad.members[0].triangles[0]=-1;
 assert.throws(()=>packGroup(v,i,g.instances[0],[bad]),/invalid/);
});

}
