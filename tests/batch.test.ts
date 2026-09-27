import test from 'node:test';import assert from 'node:assert/strict';
import {makeBatch,assignMaterial,clearMaterials} from '../src/batch.ts';
import {packGroup} from '../src/structured-real.ts';
import {readFile} from 'node:fs/promises';
if(process.env.NUR_ASSET_TESTS==='0'){
 test('batch integration requires exported model assets',{skip:true},()=>{});
}else{
const root=new URL('../public/scenes/m8-fragment/',import.meta.url);
const m=JSON.parse(await readFile(new URL('scene.json',root),'utf8')),r=JSON.parse(await readFile(new URL('repetitions.json',root),'utf8'));
const meshes=[];
for(const [gi,g] of m.groups.entries()){
 const fs=r.families.filter((f:{group:number})=>f.group===gi);if(!fs.length)continue;
 const vb=await readFile(new URL(g.vertices,root)),ib=await readFile(new URL(g.indices,root));
 meshes.push(...packGroup(new Float32Array(vb.buffer.slice(vb.byteOffset,vb.byteOffset+vb.byteLength)),new Uint32Array(ib.buffer.slice(ib.byteOffset,ib.byteOffset+ib.byteLength)),g.instances[0],fs));
}
test('every batched corner decodes to the same template vertex and transform as legacy instancing',()=>{
 const b=makeBatch(meshes);let at=0,element=0;const meta=new Uint32Array(b.instances.buffer);
 for(const mesh of meshes.filter(m=>m.family>0))for(let copy=0;copy<mesh.instances.length/28;copy++){
  assert.deepEqual(b.instances.slice(element*32,element*32+28),mesh.instances.slice(copy*28,(copy+1)*28));
  assert.deepEqual([...meta.slice(element*32+28,element*32+32)],[element+1,0,mesh.family,copy]);
  for(const old of mesh.indices){const encoded=b.indices[at++],vertex=encoded&65535;assert.equal(encoded>>>16,element);assert.deepEqual(b.vertices.slice(vertex*10,vertex*10+10),mesh.vertices.slice(old*10,old*10+10));}
  element++;
 }
 assert.equal(at,b.indices.length);assert.equal(at/3,r.summary.repeatedTriangles);assert.equal(element,r.summary.repeatedComponents);
 assert.equal(new Set(b.elements.map(e=>e.id)).size,element);
 assert.equal(b.vertices.length/10,9509);
});
test('one-copy and whole-family materials affect only intended elements and reset without changing geometry',()=>{
 const b=makeBatch(meshes),geometry=b.vertices.slice(),indices=b.indices.slice(),transforms=b.instances.slice();
 const family=31,target=b.elements.find(e=>e.family===family&&e.copy===0)!;
 assert.equal(assignMaterial(b,family,0,[1,.2,.1],.8),1);
 assert.deepEqual(b.elements.filter(e=>e.material!==0).map(e=>e.id),[target.id]);
 assert.equal(assignMaterial(b,family,null,[.1,.2,1],.3),40);
 assert.equal(b.elements.filter(e=>e.material!==0).length,40);
 const meta=new Uint32Array(b.instances.buffer);
 for(const e of b.elements){assert.equal(meta[(e.id-1)*32+29],e.family===family?e.id:0);assert.deepEqual(b.instances.slice((e.id-1)*32,(e.id-1)*32+28),transforms.slice((e.id-1)*32,(e.id-1)*32+28));}
 assert.deepEqual(b.vertices,geometry);assert.deepEqual(b.indices,indices);clearMaterials(b);
 assert.deepEqual(b.instances,transforms);assert.ok(b.materials.every(x=>x===0));
 assert.throws(()=>assignMaterial(b,99999,null,[1,1,1],0),/No matching/);
 assert.throws(()=>assignMaterial(b,31,null,[NaN,1,1],0),/Invalid/);
});
test('address overflow is rejected instead of wrapping onto another element',()=>{
 const template=meshes.find(m=>m.family>0)!;
 assert.throws(()=>makeBatch([{...template,vertices:new Float32Array(65537*10)}]),/16-bit/);
 assert.throws(()=>makeBatch([{...template,instances:new Float32Array(65537*28)}]),/16-bit/);
});
test('PBR slots preserve roughness and metallic per copy and reject invalid values atomically',()=>{
 const b=makeBatch(meshes),before=b.instances.slice();
 assignMaterial(b,31,null,[.6,.4,.1],0,.8,1);
 assignMaterial(b,31,0,[.6,.4,.1],0,.1,0);
 for(const e of b.elements.filter(e=>e.family===31)){
  const p=b.materials.subarray(e.material*8,e.material*8+8);
  assert.equal(p[4],0);assert.ok(Math.abs(p[5]-(e.copy===0?.1:.8))<1e-6);assert.equal(p[6],e.copy===0?0:1);
 }
 const snapshot=b.materials.slice(),instanceSnapshot=b.instances.slice();
 for(const [rough,metal] of [[0,0],[1.1,0],[NaN,0],[.5,NaN],[.5,-1],[.5,1.1],[.5,Infinity]])assert.throws(()=>assignMaterial(b,31,null,[1,1,1],0,rough,metal),/PBR/);
 assert.deepEqual(b.materials,snapshot);assert.deepEqual(b.instances,instanceSnapshot);
 clearMaterials(b);assert.deepEqual(b.instances,before);
});

}
