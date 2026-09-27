import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {decodeHDR,diffuseSH,shBasis,halfFloat,HDR_SOURCE} from '../src/hdr-environment.ts';
import {sourceDigest} from '../src/structured-real.ts';

test('Radiance RLE decoding retains HDR range and rejects truncated or malformed runs',()=>{
  const header=new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 8\n');
  const data=new Uint8Array([...header,2,2,0,8,136,128,136,64,136,32,136,130]);
  const image=decodeHDR(data);assert.equal(image.width,8);assert.equal(image.height,1);
  for(let i=0;i<8;i++)assert.deepEqual([...image.data.subarray(i*4,i*4+4)],[2.0078125,1.0078125,.5078125,1]);
  assert.throws(()=>decodeHDR(data.subarray(0,data.length-1)),/Truncated/);
  const invalid=data.slice();invalid[header.length+4]=0;assert.throws(()=>decodeHDR(invalid),/Invalid HDR run/);
  assert.equal(halfFloat(1),0x3c00);assert.equal(halfFloat(65504),0x7bff);assert.equal(halfFloat(2**-24),1);assert.equal(halfFloat(0),0);
  assert.throws(()=>halfFloat(Infinity));
});
test('SH diffuse integration reproduces constant radiance in all six axial directions',()=>{
  const width=128,height=64,data=new Float32Array(width*height*4);
  for(let i=0;i<width*height;i++)data.set([.25,.5,2,1],i*4);
  const sh=diffuseSH(width,height,data);
  for(const d of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]){
    const basis=shBasis(...d as [number,number,number]);
    for(let c=0;c<3;c++){const result=basis.reduce((n,b,i)=>n+b*sh[i*4+c],0);assert.ok(Math.abs(result-[.25,.5,2][c])<.001);}
  }
});
test('bundled HDR is unmodified, finite, non-LDR and correctly oriented',{skip:process.env.NUR_ASSET_TESTS==='0'},async()=>{
  const bytes=await readFile(new URL('../public'+HDR_SOURCE.file,import.meta.url));assert.equal(await sourceDigest([bytes]),HDR_SOURCE.sha256);
  const hdr=decodeHDR(bytes);assert.equal(hdr.width,1024);assert.equal(hdr.height,512);
  let max=0;for(const v of hdr.data){assert.ok(Number.isFinite(v)&&v>=0);max=Math.max(max,v);}assert.ok(max>1);
  assert.ok(diffuseSH(hdr.width,hdr.height,hdr.data).every(Number.isFinite));
});
