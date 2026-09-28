import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePackRanges,slicePack,selectDetailLevel} from '../src/stream-layout.ts';
test('bootstrap ranges must exactly cover the pack without overlaps, gaps or unbounded allocation',()=>{
 const parts=[{packed:{offset:0,vertexBytes:4,indexBytes:2}},{packed:{offset:6,vertexBytes:2,indexBytes:2}}];
 validatePackRanges(parts,10);
 const data=Uint8Array.from({length:10},(_,i)=>i).buffer;
 const {vb,ib}=slicePack(data,parts[1].packed);assert.deepEqual([...new Uint8Array(vb)],[6,7]);assert.deepEqual([...new Uint8Array(ib)],[8,9]);
 for(const offset of [5,7,-1,NaN])assert.throws(()=>validatePackRanges([parts[0],{packed:{...parts[1].packed,offset}}],10));
 assert.throws(()=>validatePackRanges(parts,11));assert.throws(()=>validatePackRanges(parts,129*1024*1024));
 assert.throws(()=>slicePack(data,{offset:8,vertexBytes:2,indexBytes:2}));
 assert.throws(()=>slicePack(data,{offset:0,vertexBytes:1.5,indexBytes:2}));
});
test('three-level selection refines near surfaces and avoids threshold oscillation',()=>{
 assert.equal(selectDetailLevel([.5,.1],()=>false),-1);
 assert.equal(selectDetailLevel([3,.5],()=>false),0);
 assert.equal(selectDetailLevel([30,5],()=>false),1);
 assert.equal(selectDetailLevel([3,.9],()=>true),1);
 assert.equal(selectDetailLevel([3,.69],()=>true),0);
 assert.equal(selectDetailLevel([.9,.1],()=>true),0);
});
