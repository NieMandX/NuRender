import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validatePrefiltered} from '../src/prefiltered-ibl.ts';
import {sourceDigest} from '../src/structured-real.ts';
function half(x:number){const sign=x>>15?-1:1,exp=(x>>10)&31,m=x&1023;return sign*(exp===0?m*2**-24:exp===31?Infinity:(1+m/1024)*2**(exp-15));}
test('prefiltered environment has intact, finite linear HDR mips and energy-bounded Smith LUT', {skip:process.env.NUR_ASSET_TESTS==='0'}, async()=>{
 const root=new URL('../public/environments/prefiltered/',import.meta.url),meta=JSON.parse(await readFile(new URL('manifest.json',root),'utf8'));
 const spec=await readFile(new URL('specular.bin',root)),brdf=await readFile(new URL('brdf.bin',root));validatePrefiltered(meta,spec.buffer.slice(spec.byteOffset,spec.byteOffset+spec.byteLength),brdf.buffer.slice(brdf.byteOffset,brdf.byteOffset+brdf.byteLength));
 assert.equal(await sourceDigest([spec]),meta.specularSHA256);assert.equal(await sourceDigest([brdf]),meta.brdfSHA256);
 for(const data of [spec,brdf])for(let i=0;i<data.length;i+=2){const f=half(data.readUInt16LE(i));assert.ok(Number.isFinite(f)&&f>=0);}
 for(let i=0;i<brdf.length;i+=8){assert.ok(half(brdf.readUInt16LE(i))+half(brdf.readUInt16LE(i+2))<=1.01);assert.equal(half(brdf.readUInt16LE(i+6)),1);}
 assert.throws(()=>validatePrefiltered({...meta,sourceSHA256:'wrong'},new ArrayBuffer(spec.length),new ArrayBuffer(brdf.length)));
 assert.throws(()=>validatePrefiltered({...meta,records:meta.records.slice(1)},new ArrayBuffer(spec.length),new ArrayBuffer(brdf.length)));
});

test('cubemap face orientation agrees with source panorama on every axis and corner', {skip:process.env.NUR_ASSET_TESTS==='0'}, async()=>{
 const {decodeHDR}=await import('../src/hdr-environment.ts');
 const root=new URL('../public/environments/',import.meta.url),hdr=decodeHDR(await readFile(new URL('urban_courtyard_02_1k.hdr',root))),spec=await readFile(new URL('prefiltered/specular.bin',root));
 const sample=(x:number,y:number,z:number)=>{const length=Math.hypot(x,y,z),u=Math.atan2(z,x)/(2*Math.PI)+.5,v=Math.acos(y/length)/Math.PI,px=u*hdr.width-.5,py=Math.max(0,Math.min(hdr.height-1,v*hdr.height-.5)),ix=Math.floor(px),iy=Math.floor(py),fx=px-ix,fy=py-iy;return [0,1,2].map(c=>{const get=(xx:number,yy:number)=>hdr.data[(yy*hdr.width+(xx+hdr.width)%hdr.width)*4+c];return (get(ix,iy)*(1-fx)+get(ix+1,iy)*fx)*(1-fy)+(get(ix,Math.min(iy+1,hdr.height-1))*(1-fx)+get(ix+1,Math.min(iy+1,hdr.height-1))*fx)*fy;});};
 for(let face=0;face<6;face++)for(const [ix,iy] of [[0,0],[255,255],[128,128],[192,64]]){
  const x=(ix+.5)/256*2-1,y=(iy+.5)/256*2-1;
  const d=[[1,-y,-x],[-1,-y,x],[x,1,y],[x,-1,-y],[x,-y,1],[-x,-y,-1]][face],expected=sample(d[0],d[1],d[2]);
  for(let c=0;c<3;c++){const actual=half(spec.readUInt16LE((face*256*256+iy*256+ix)*8+c*2));assert.ok(Math.abs(actual-expected[c])<.002*Math.max(1,expected[c]),`face ${face}, channel ${c}`);}
 }
});
