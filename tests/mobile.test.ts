import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {MeshoptDecoder,MeshoptEncoder} from 'meshoptimizer';
import {compactMobile} from '../scripts/mobile-codec.mjs';
import {chooseProfile,renderSize} from '../src/device-profile.ts';
import {sourceDigest} from '../src/structured-real.ts';

test('mobile detection includes desktop-UA iPads; explicit selection wins; pixel budget is respected',()=>{
 assert.equal(chooseProfile(null,5,'Macintosh',false),'mobile');
 assert.equal(chooseProfile(null,0,'Linux Android',true),'mobile');
 assert.equal(chooseProfile('desktop',5,'iPad',true),'desktop');
 assert.equal(chooseProfile(null,0,'Macintosh',false),'desktop');
 assert.deepEqual(renderSize(390,500,3,8192,'mobile'),[390,500]);
 const [w,h]=renderSize(2000,1600,3,8192,'mobile');assert.ok(w*h<=1e6);assert.ok(Math.abs(w/h-1.25)<.002);
 assert.deepEqual(renderSize(1200,900,2,8192,'desktop'),[2400,1800]);
});
test('packed vertices preserve UV seams and affine position transforms with bounded quantization',async()=>{
 const vertices=new Float32Array([1,2,3,0,1,0,-3000.123,7000.456, 2,5,8,.3,.4,.866,1,2, 1,2,3,0,1,0,-3000.123,7000.456, 1,2,3,0,1,0,1,2]);
 const matrix=[0,2,0,0,-3,0,0,0,0,0,4,0,9,8,7,1,0,1,0,0,-1,0,0,0,0,0,1,0];
 const packed=compactMobile(vertices,new Uint32Array([0,1,2,0,1,3]),[matrix]);assert.equal(packed.count,3);assert.equal(packed.indices[0],packed.indices[2]);assert.notEqual(packed.indices[0],packed.indices[5]);
 const view=new DataView(packed.vertices.buffer),m=packed.instances[0];
 for(let i=0;i<6;i++){const old=[0,1,2,0,1,3][i],at=packed.indices[i]*20;const pos=[0,1,2].map(a=>view.getUint16(at+a*2,true)/65535);
  for(let row=0;row<3;row++){const world=m[12+row]+pos.reduce((n,p,col)=>n+m[col*4+row]*p,0),expected=matrix[12+row]+[0,1,2].reduce((n,col)=>n+matrix[col*4+row]*vertices[old*8+col],0);assert.ok(Math.abs(world-expected)<=packed.maxWorldPositionError+1e-6);}
  assert.equal(view.getFloat32(at+12,true),vertices[old*8+6]);assert.equal(view.getFloat32(at+16,true),vertices[old*8+7]);
 }
 assert.deepEqual(m.slice(16),matrix.slice(16));await MeshoptEncoder.ready;await MeshoptDecoder.ready;
 const compressed=MeshoptEncoder.encodeVertexBuffer(packed.vertices,packed.count,20),decoded=new Uint8Array(packed.vertices.length);MeshoptDecoder.decodeVertexBuffer(decoded,packed.count,20,compressed);assert.deepEqual(decoded,packed.vertices);
});
test('mobile asset set is complete, decodes in bounded parts and retains every object', {skip:process.env.NUR_ASSET_TESTS==='0'}, async()=>{
 await MeshoptDecoder.ready;const root=new URL('../public/scenes/m8-mobile/',import.meta.url),raw=await readFile(new URL('scene.json',root)),m=JSON.parse(raw.toString()),full=JSON.parse(await readFile(new URL('../public/scenes/m8-full/scene.json',import.meta.url),'utf8'));
 assert.deepEqual(m.objects.map((o:any)=>o.name),full.objects.map((o:any)=>o.name));assert.deepEqual(m.bounds,full.bounds);
 const textures=JSON.parse(await readFile(new URL('textures.json',root),'utf8'));assert.equal(textures.sourceDigest,await sourceDigest([raw]));
 let bytes=0,download=0,triangles=0;
 assert.ok(Number.isFinite(m.lod.maxWorldPositionError));
 for(const g of m.groups){assert.ok(g.vertexCount>0&&g.indexCount>0);const [v,i]=await Promise.all([readFile(new URL(g.vertices,root)),readFile(new URL(g.indices,root))]);assert.equal(await sourceDigest([v]),g.vertexDigest);assert.equal(await sourceDigest([i]),g.indexDigest);
  const vertices=new Uint8Array(g.vertexCount*20),indices=new Uint16Array(g.indexCount);MeshoptDecoder.decodeVertexBuffer(vertices,g.vertexCount,20,v);MeshoptDecoder.decodeIndexBuffer(new Uint8Array(indices.buffer),g.indexCount,2,i);assert.ok(indices.every(i=>i<g.vertexCount));assert.ok(g.instances.every((m:number[])=>m.length===28&&m.every(Number.isFinite)));bytes+=vertices.length+indices.byteLength;download+=v.length+i.length;triangles+=g.indexCount/3*g.instances.length;
 }
 assert.equal(bytes,m.lod.geometryBytes);assert.equal(download,m.lod.downloadBytes);assert.equal(triangles,m.triangles);assert.ok(bytes<360e6);assert.ok(download<135e6);assert.ok(triangles<full.triangles);
 for(const image of textures.images){assert.equal(image.width,256);assert.equal(image.height,256);assert.equal(await sourceDigest([await readFile(new URL(image.file,root))]),image.sha256);}
});
