import {test} from 'node:test';
import assert from 'node:assert/strict';
import {template,buildings,expand,packTemplate,packBuildings,cube,ground} from '../src/scene.ts';
import {percentile,summarize} from '../src/stats.ts';
test('structured decoding matches flattened baseline within float32 precision',()=>{
 for(const detail of ['full','medium','mass'] as const){
  const parts=template(detail),items=buildings(64),a=expand(parts,items),t=packTemplate(parts),b=packBuildings(items);
  for(let i=0;i<parts.length*items.length;i++){
   const p=(i%parts.length)*12,bi=Math.floor(i/parts.length)*8,o=i*12;
   const position=[Math.fround(t[p]+b[bi]),Math.fround(t[p+1]*b[bi+3]),Math.fround(t[p+2]+b[bi+2])];
   for(let axis=0;axis<3;axis++)assert.ok(Math.abs(position[axis]-a[o+axis])<.00002);
   for(let axis=0;axis<3;axis++)assert.ok(Math.abs(Math.fround(t[p+4+axis]*(axis===1?b[bi+3]:1))-a[o+4+axis])<.00001);
   for(let axis=0;axis<3;axis++)assert.equal(t[p+3]?b[bi+4+axis]:t[p+8+axis],a[o+8+axis]);
  }
  assert.ok(t.byteLength+b.byteLength<a.byteLength);
 }
});
test('LOD reduces identical A/B geometry, shared cube indices valid',()=>{
 assert.ok(template('full').length>template('medium').length);
 assert.ok(template('medium').length>template('mass').length);
 const mesh=cube();assert.equal(mesh.vertices.length/6,24);assert.equal(mesh.indices.length,36);
 assert.ok([...mesh.indices].every(i=>i<24));assert.equal(ground(16).length/12,17);
});
test('statistics exclude unavailable GPU values without reporting a fake zero',()=>{
 assert.equal(percentile([],0.5),null);
 assert.equal(percentile([3,1,2],.5),2);
 assert.deepEqual(summarize([{frame:16,cpu:1,gpu:null}]).gpu,{median:null,p95:null,count:0});
});

test('ordinary merged building meshes reproduce box-instance vertices exactly',async()=>{
 const {sceneGroups,mergedMesh}=await import('../src/scene.ts');
 const unit=cube();
 for(const group of sceneGroups(16,'full',4)){
  const merged=mergedMesh(group.parts),flat=expand(group.parts,group.items);
  assert.equal(merged.indices.length,group.parts.length*36);
  for(let b=0;b<group.items.length;b++)for(let p=0;p<group.parts.length;p++)for(let v=0;v<24;v++){
   const f=Math.fround,origin=group.items[b],bi=(b*group.parts.length+p)*12,mi=(p*24+v)*10;
   for(let axis=0;axis<3;axis++){
    const worldA=f(f(unit.vertices[v*6+axis]*flat[bi+4+axis])+flat[bi+axis]);
    const worldC=f(f(merged.vertices[mi+axis]*(axis===1?origin.heightScale:1))+(axis===0?origin.x:axis===2?origin.z:0));
    assert.equal(worldA,worldC);
   }
  }
 }
});
test('heterogeneous groups cover every building and unique residuals are shared',async()=>{
 const {sceneGroups,commonParts}=await import('../src/scene.ts');
 for(const types of [1,4,16]){const groups=sceneGroups(64,'full',types);assert.equal(groups.length,types);assert.equal(groups.reduce((n,g)=>n+g.items.length,0),64);assert.equal(commonParts(64,'full',types).length/12,193);}
});
test('image comparison detects changes and rejects invalid dimensions',async()=>{
 const {comparePixels}=await import('../src/quality.ts');
 const a=new Uint8Array([0,0,0,255]),b=new Uint8Array([1,0,0,255]);assert.equal(comparePixels(a,a).exact,true);assert.equal(comparePixels(a,b).changedPixels,1);assert.throws(()=>comparePixels(a,new Uint8Array(8)));
});
