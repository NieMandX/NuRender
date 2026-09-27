import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {withTextureCoordinates} from '../src/texture-coordinates.ts';
import {makeBatch} from '../src/batch.ts';
import {components, type Family} from '../src/repetitions.ts';
import {packGroup,sourceDigest} from '../src/structured-real.ts';
import {loadTextureManifest,loadCornerData,type TextureManifest} from '../src/texture-assets.ts';

const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1,1,0,0,0,0,1,0,0,0,0,1,0];
test('UV seams, different per-copy UVs and material IDs survive template packing and GPU address decoding',()=>{
  const v:number[]=[],idx:number[]=[],uv:number[]=[];
  for(let copy=0;copy<3;copy++){
    for(const [x,y] of [[0,0],[1,0],[1,1],[0,1]])v.push(x+copy*3,y,0,0,0,1,.5,.5,.5,0);
    // Reverse triangle order and cyclically rotate corners in alternate copies.
    const order=copy===1?[2,3,0,1,2,0]:[0,1,2,0,2,3];
    order.forEach((corner,k)=>{idx.push(copy*4+corner);uv.push(copy*10+corner,copy*20+(k===0?5:0),copy+1,0);});
  }
  const vertices=new Float32Array(v),indices=new Uint32Array(idx),corners=new Float32Array(uv);
  const parts=components(vertices,indices,identity),family:Family={id:7,group:0,object:'sample',copies:3,trianglesPerCopy:2,maxErrorMetres:0,bounds:[[0,0,0],[7,1,0]],members:parts.map((p,i)=>({triangles:p.triangles,translation:[i*3,0,0]}))};
  const packed=packGroup(vertices,indices,identity,[family])[0];
  const mesh=withTextureCoordinates(packed,corners,family,new Map(parts.map(p=>[p.triangles[0],p])));
  assert.ok(mesh.vertices.length>packed.vertices.length,'a shared geometric vertex needs multiple UV records');
  const batch=makeBatch([mesh]);
  for(let copy=0;copy<3;copy++){
    const expected:string[]=[],actual:string[]=[];
    for(const t of family.members[copy].triangles)for(let c=0;c<3;c++){
      const corner=t*3+c,pos=vertices.subarray(indices[corner]*10,indices[corner]*10+3);
      expected.push([...pos,...corners.subarray(corner*4,corner*4+4)].join(','));
    }
    for(let c=0;c<mesh.indices.length;c++){
      const address=batch.indices[copy*mesh.indices.length+c],vertex=address&65535,element=address>>>16;
      const attr=batch.texcoordOffsets[element*2]+vertex-batch.texcoordOffsets[element*2+1];
      const pos=Array.from(batch.vertices.subarray(vertex*10,vertex*10+3));pos[0]+=batch.instances[element*32+12];
      actual.push([...pos,...batch.texcoords.subarray(attr*4,attr*4+4)].join(','));
    }
    assert.deepEqual(actual.sort(),expected.sort());
  }
});

test('bundled texture maps have valid provenance, channel mappings and immutable packed image hashes', {skip:process.env.NUR_ASSET_TESTS==='0'}, async()=>{
  const root=new URL('../public/scenes/m8-fragment/',import.meta.url),m:TextureManifest=JSON.parse(await readFile(new URL('textures.json',root),'utf8'));
  const raw=await readFile(new URL('scene.json',root)),scene=JSON.parse(raw.toString()),chunks:Uint8Array[]=[raw];
  for(const g of scene.groups)chunks.push(await readFile(new URL(g.vertices,root)),await readFile(new URL(g.indices,root)));
  assert.equal(m.sourceDigest,await sourceDigest(chunks));assert.equal(m.groups.length,scene.groups.length);assert.deepEqual(m.warnings,[]);
  for(const image of m.images)assert.equal(await sourceDigest([await readFile(new URL(image.file,root))]),image.sha256);
  for(const mat of m.materials){
    for(const map of Object.values(mat.maps)){assert.ok(m.images[map.image]);assert.equal(map.matrix.length,6);assert.ok(map.matrix.every(Number.isFinite));}
    if(mat.maps.roughness)assert.equal(mat.maps.roughness.channel,1);
    if(mat.maps.metallic)assert.equal(mat.maps.metallic.channel,2);
    if(mat.maps.normal)assert.equal(mat.maps.normal.srgb,false);
  }
  const old=globalThis.fetch;
  try{
    globalThis.fetch=async input=>new Response(await readFile(new URL('../public'+String(input),import.meta.url)));
    assert.equal((await loadTextureManifest(m.sourceDigest)).materials.length,38);
    await assert.rejects(()=>loadTextureManifest('wrong'),/другой геометрии/);
    for(const [i,g] of scene.groups.entries()){
      const corners=await loadCornerData(m,i,g.name,g.indexCount);assert.equal(corners.length,g.indexCount*4);
    }
    await assert.rejects(()=>loadCornerData({...m,groups:m.groups.map(g=>({...g,sha256:'wrong'}))},0,scene.groups[0].name,scene.groups[0].indexCount),/Повреждены/);
  }finally{globalThis.fetch=old;}
});
