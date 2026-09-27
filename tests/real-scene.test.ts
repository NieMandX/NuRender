import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
if(process.env.NUR_ASSET_TESTS==='0'){
 test('real-scene integration requires exported model assets',{skip:true},()=>{});
}else{
const root=new URL('../public/scenes/m8-fragment/',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('scene.json',root),'utf8'));
const floats=(file:string)=>{const b=readFileSync(new URL(file,root));return new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength));};
test('Blender export has valid indices, finite attributes and exact triangle accounting',()=>{
 let triangles=0,objects=0;
 for(const g of manifest.groups){
  const v=floats(g.vertices),ib=readFileSync(new URL(g.indices,root));
  const indices=new Uint32Array(ib.buffer.slice(ib.byteOffset,ib.byteOffset+ib.byteLength));
  assert.equal(v.length,g.vertexCount*10);assert.equal(indices.length,g.indexCount);
  for(const n of v)assert.ok(Number.isFinite(n));for(const i of indices)assert.ok(i<g.vertexCount);
  for(const transform of g.instances){assert.equal(transform.length,28);assert.equal(transform[15],1);assert.ok(transform.every(Number.isFinite));}
  triangles+=g.indexCount/3*g.instances.length;objects+=g.instances.length;
 }
 assert.equal(triangles,manifest.triangles);assert.equal(objects,manifest.objects.length);
});
test('exact crop bounds and genuine linked meshes are preserved',()=>{
 assert.ok(manifest.bounds[0][0]>=-50.001&&manifest.bounds[1][0]<=50.001);
 assert.ok(manifest.bounds[0][2]>=-50.001&&manifest.bounds[1][2]<=50.001);
 assert.ok(manifest.groups.some((g:{instances:unknown[]})=>g.instances.length>1));
 assert.ok(manifest.groups.length<manifest.objects.length);
});

}
