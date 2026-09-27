import test from 'node:test';
import assert from 'node:assert/strict';
import {makeBatch,assignMaterial} from '../src/batch.ts';
import {exportMaterialPack,importMaterialPack,parseMaterialPack,materialStorageKey,MAX_PACK_BYTES} from '../src/material-pack.ts';

const identity={sourceDigest:'a'.repeat(64),layoutDigest:'b'.repeat(64)};
function fixture(){
  return makeBatch([31,52].map(family=>({family,vertices:new Float32Array(30),indices:new Uint32Array([0,1,2]),instances:Float32Array.from({length:3*28},(_,i)=>i/4),labels:new Uint32Array(3).fill(family),sourceTriangles:[0]})));
}
function edited(){const b=fixture();assignMaterial(b,31,null,[.6,.4,.1],.4,.8,1);assignMaterial(b,31,1,[.1,.2,.7],2,.05,0);return b;}
function snapshot(b:ReturnType<typeof fixture>){return {instances:new Uint8Array(b.instances.buffer).slice(),materials:b.materials.slice(),elements:structuredClone(b.elements),vertices:b.vertices.slice(),indices:b.indices.slice()};}
test('JSON round trip preserves group/copy overrides and GPU bytes, replacing previous assignments',()=>{
  const source=edited(),pack=parseMaterialPack(JSON.stringify(exportMaterialPack(source,identity))),dest=fixture();
  assignMaterial(dest,52,null,[1,0,0],1);
  assert.equal(importMaterialPack(pack,dest,identity),3);
  assert.deepEqual(snapshot(dest),snapshot(source));
  // The document order must not be used as the GPU element address.
  const reversed=exportMaterialPack(source,identity);reversed.assignments.reverse();
  importMaterialPack(reversed,dest,identity);assert.deepEqual(snapshot(dest),snapshot(source));
});
test('invalid documents never partially clear or update existing GPU material data',()=>{
  const b=edited(),before=snapshot(b),original=exportMaterialPack(b,identity);
  const invalid=[
    null,[],{...original,format:'other'},{...original,version:2},{...original,colorSpace:'srgb'},
    {...original,sourceDigest:'other'},{...original,layoutDigest:'other'},
    {...original,assignments:null},{...original,assignments:Array(7).fill(original.assignments[0])},
    {...original,assignments:[original.assignments[0],original.assignments[0]]},
  ];
  for(const change of [{elementId:99},{elementId:1.5},{family:52},{copy:9},{baseColor:[0,1]},{baseColor:[0,1,NaN]},{baseColor:[-1,0,0]},{emission:Infinity},{emission:3},{roughness:0},{roughness:1.1},{metallic:-.1},{metallic:'1'}]){
    // Put a valid assignment first to expose mutation-before-validation bugs.
    invalid.push({...original,assignments:[original.assignments[0],{...original.assignments[1],...change}]});
  }
  for(const value of invalid){assert.throws(()=>importMaterialPack(value,b,identity));assert.deepEqual(snapshot(b),before);}
});
test('empty file resets overrides and exports contain no shared mutable arrays',()=>{
  const b=edited(),p=exportMaterialPack(b,identity);p.assignments[0].baseColor[0]=0;
  assert.notEqual(b.materials[8],0);
  assert.equal(importMaterialPack({...p,assignments:[]},b,identity),0);
  assert.deepEqual(snapshot(b),snapshot(fixture()));
});
test('parser limits UTF-8 bytes and rejects malformed JSON; storage keys separate scene and layout',()=>{
  assert.throws(()=>parseMaterialPack('{'),/JSON/);
  assert.throws(()=>parseMaterialPack(' '.repeat(MAX_PACK_BYTES+1)),/2 МиБ/);
  assert.throws(()=>parseMaterialPack('"'+'я'.repeat(MAX_PACK_BYTES/2)+'"'),/2 МиБ/);
  assert.deepEqual(parseMaterialPack('{}'),{});
  assert.notEqual(materialStorageKey(identity),materialStorageKey({...identity,sourceDigest:'c'.repeat(64)}));
  assert.notEqual(materialStorageKey(identity),materialStorageKey({...identity,layoutDigest:'c'.repeat(64)}));
});
