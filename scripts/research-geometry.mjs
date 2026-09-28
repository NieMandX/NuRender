// Offline measurements only: never replaces a scene or writes source assets.
// node scripts/research-geometry.mjs /private/tmp/nurender-geometry-research.json
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {MeshoptSimplifier as M,MeshoptDecoder as D} from 'meshoptimizer';

const full=new URL('../public/scenes/m8-full/',import.meta.url);
const mobile=new URL('../public/scenes/m8-mobile/',import.meta.url);
const fullRaw=await readFile(new URL('scene.json',full));
const mobileRaw=await readFile(new URL('scene.json',mobile));
const source=JSON.parse(fullRaw),small=JSON.parse(mobileRaw);
assert.equal(small.vertexFormat,'unorm16x4-snorm8x4-float32x2','This experiment expects the 20-byte mobile format');
assert.equal(small.compression,'meshopt');
assert.equal(small.lod.sourceDigest,createHash('sha256').update(fullRaw).digest('hex'),'Mobile export must derive from this full scene');
const textures=JSON.parse(await readFile(new URL('textures.json',mobile)));
const hash=b=>createHash('sha256').update(b).digest('hex');
await Promise.all([M.ready,D.ready]);
const weights=[.002,.002,.002,.0002,.0002];
function simplify(v,idx,error){
  const attr=new Float32Array(v.length/8*5);
  for(let n=0;n<v.length/8;n++)attr.set(v.subarray(n*8+3,n*8+8),n*5);
  const start=performance.now();
  const [out,measured]=M.simplifyWithAttributes(idx,v,8,attr,5,weights,null,Math.max(3,Math.floor(idx.length*.15/3)*3),error,['Permissive','LockBorder','ErrorAbsolute']);
  return {triangles:out.length/3,error:measured,ms:performance.now()-start};
}
async function load(g){
  const [vb,ib]=await Promise.all([readFile(new URL(g.vertices,full)),readFile(new URL(g.indices,full))]);
  if(hash(vb)!==g.vertexDigest||hash(ib)!==g.indexDigest)throw Error('Source hash mismatch');
  return {v:new Float32Array(vb.buffer,vb.byteOffset,vb.length/4),idx:new Uint32Array(ib.buffer,ib.byteOffset,ib.length/4)};
}
// Exact bitwise vertex welding, including normal and UV. No proximity joins,
// component pruning, or merging of different objects/materials/instances.
function weld(parts){
  const map=new Map(),v=new Float32Array(parts.reduce((s,p)=>s+p.v.length,0));
  const idx=new Uint32Array(parts.reduce((s,p)=>s+p.idx.length,0));let count=0,at=0;
  for(const p of parts){
    const bits=new Uint32Array(p.v.buffer,p.v.byteOffset,p.v.length),remap=new Uint32Array(p.v.length/8);
    for(let i=0;i<remap.length;i++){
      const key=bits.subarray(i*8,i*8+8).join(',');let dest=map.get(key);
      if(dest===undefined){dest=count++;map.set(key,dest);v.set(p.v.subarray(i*8,i*8+8),dest*8);}
      remap[i]=dest;
    }
    for(const i of p.idx)idx[at++]=remap[i];
  }
  return {v:v.slice(0,count*8),idx};
}
const chunks=[];
for(const family of [184,201,178,43]){
  const groups=source.groups.filter(g=>g.family===family);
  // First/middle/last windows, deterministic and independent; not the entire family.
  for(const start of [...new Set([0,Math.floor((groups.length-8)/2),groups.length-8])]){
    const selection=groups.slice(start,start+8);
    if(selection.some(g=>JSON.stringify([g.material,g.instances,g.objects])!==JSON.stringify([selection[0].material,selection[0].instances,selection[0].objects])))throw Error('Incompatible chunks');
    const parts=await Promise.all(selection.map(load));
    // Same absolute bound for every original part and merged candidate, so a
    // larger bounding box cannot silently authorize a larger simplification error.
    const absoluteError=Math.min(...parts.map(p=>M.getScale(p.v,8)*.005));
    const separate=parts.map(p=>simplify(p.v,p.idx,absoluteError));
    const combined=weld(parts),merged=simplify(combined.v,combined.idx,absoluteError);
    assert.ok([...separate,merged].every(r=>r.triangles>0&&r.error<=absoluteError*1.00001),'Invalid simplification result or exceeded error budget');
    const row={family,name:source.families[family-1].object,parts:selection.map(g=>g.vertices),absoluteError,
      trianglesBefore:combined.idx.length/3,separateTriangles:separate.reduce((s,p)=>s+p.triangles,0),mergedTriangles:merged.triangles,
      verticesBefore:parts.reduce((s,p)=>s+p.v.length/8,0),verticesAfterWeld:combined.v.length/8,
      separateMaxError:Math.max(...separate.map(p=>p.error)),mergedError:merged.error,
      separateMs:separate.reduce((s,p)=>s+p.ms,0),mergedMs:merged.ms};
    chunks.push(row);console.log(JSON.stringify({family,start,separate:row.separateTriangles,merged:row.mergedTriangles}));
  }
}
const uv=[];
for(const [part,g] of small.groups.entries()){
  const encoded=await readFile(new URL(g.vertices,mobile));
  if(hash(encoded)!==g.vertexDigest)throw Error('Mobile hash mismatch');
  const raw=new Uint8Array(g.vertexCount*20);D.decodeVertexBuffer(raw,g.vertexCount,20,encoded);const view=new DataView(raw.buffer);
  const lo=[Infinity,Infinity],hi=[-Infinity,-Infinity];
  for(let i=0;i<g.vertexCount;i++)for(let a=0;a<2;a++){const x=view.getFloat32(i*20+12+a*4,true);lo[a]=Math.min(lo[a],x);hi[a]=Math.max(hi[a],x);}
  const scale=hi.map((v,a)=>Math.fround(v-lo[a])),offset=lo.map(Math.fround),delta=[0,0];
  // Include float32 shader multiply/add rounding, not only the ideal quantizer.
  for(let i=0;i<g.vertexCount;i++)for(let a=0;a<2;a++){
    const x=view.getFloat32(i*20+12+a*4,true),q=Math.max(0,Math.min(65535,Math.round((x-offset[a])/(scale[a]||1)*65535)));
    const restored=Math.fround(Math.fround(Math.fround(q/65535)*scale[a])+offset[a]);
    delta[a]=Math.max(delta[a],Math.abs(x-restored));
  }
  let texelBound=0;
  for(const map of Object.values(textures.materials[g.material-1].maps)){
    // All mobile maps are uploaded into 256x256 array layers.
    const m=map.matrix;
    texelBound=Math.max(texelBound,256*(Math.abs(m[0])*delta[0]+Math.abs(m[1])*delta[1]),256*(Math.abs(m[3])*delta[0]+Math.abs(m[4])*delta[1]));
  }
  uv.push({part,family:g.family,vertices:g.vertexCount,lo,hi,maxUVError:delta,maxTexelBound:texelBound,savedBytes:g.vertexCount*4,hasNormalMap:!!textures.materials[g.material-1].maps.normal});
}
const report={date:'2026-09-28',sourceDigest:hash(fullRaw),mobileDigest:hash(mobileRaw),meshoptimizer:'1.3.0',
  notes:['Offline hypothesis tests, not a new renderer or implementation of any paper.','Meshopt error is its combined appearance metric, not a Hausdorff or screen-pixel guarantee.','UV analysis does not certify normal-map tangent derivatives or rendered quality.','Chunk windows are samples, not a prediction of whole-scene triangle savings.'],
  chunkExperiment:chunks,uvExperiment:{parts:uv,geometryBytes:small.lod.geometryBytes,
    potentialVertexBytesSaved:uv.reduce((s,g)=>s+g.savedBytes,0),maxTexelBound:Math.max(...uv.map(g=>g.maxTexelBound)),
    overQuarterTexel:uv.filter(g=>g.maxTexelBound>.25).length,overOneTexel:uv.filter(g=>g.maxTexelBound>1).length}};
await writeFile(process.argv[2]??'/private/tmp/nurender-geometry-research.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({...report.uvExperiment,parts:undefined}));
