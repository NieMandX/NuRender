// Opt-in pilot: spatial pages and two LODs for the two largest metal families.
// Original full/mobile exports remain untouched.
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MeshoptDecoder as D,MeshoptEncoder as E,MeshoptSimplifier as M} from 'meshoptimizer';
import {splitPages,compactPage} from './spatial-pages.mjs';
const root=new URL('../public/scenes/m8-mobile/',import.meta.url),out=new URL('../public/scenes/m8-paged/',import.meta.url);
await mkdir(out,{recursive:true});await Promise.all([D.ready,E.ready,M.ready]);
const hash=b=>createHash('sha256').update(b).digest('hex');
const raw=await readFile(new URL('scene.json',root)),source=JSON.parse(raw),textures=JSON.parse(await readFile(new URL('textures.json',root)));
if(source.vertexFormat!=='unorm16x4-snorm8x4-float32x2'||textures.sourceDigest!==hash(raw))throw Error('Unexpected mobile source');
const manifest=structuredClone(source);manifest.groups=[];const stats=[];let baseBytes=0,detailBytes=0,baseDownload=0,detailDownload=0;
async function storePage(page,prefix){
 const v=E.encodeVertexBuffer(page.vertices,page.count,20),i=E.encodeIndexBuffer(new Uint8Array(page.indices.buffer),page.indices.length,2);
 const meta={vertices:prefix+'.vertices.bin',indices:prefix+'.indices.bin',vertexCount:page.count,indexCount:page.indices.length,vertexDigest:hash(v),indexDigest:hash(i),bytes:Math.ceil(page.vertices.byteLength/4)*4+Math.ceil(page.indices.byteLength/4)*4,downloadBytes:v.length+i.length};
 await Promise.all([writeFile(new URL(meta.vertices,out),v),writeFile(new URL(meta.indices,out),i)]);return meta;
}
for(const [sourcePart,g] of source.groups.entries()){
 const vb=await readFile(new URL(g.vertices,root)),ib=await readFile(new URL(g.indices,root));if(hash(vb)!==g.vertexDigest||hash(ib)!==g.indexDigest)throw Error('Source hash mismatch');
 if(![184,201].includes(g.family)){
  const n={...g,vertices:`part-${manifest.groups.length}.vertices.bin`,indices:`part-${manifest.groups.length}.indices.bin`};
  await Promise.all([copyFile(new URL(g.vertices,root),new URL(n.vertices,out)),copyFile(new URL(g.indices,root),new URL(n.indices,out))]);
  manifest.groups.push(n);baseBytes+=g.vertexCount*20+Math.ceil(g.indexCount*2/4)*4;baseDownload+=vb.length+ib.length;continue;
 }
 if(g.instances.length!==1)throw Error('Pilot expects one instance per metal part');
 const bytes=new Uint8Array(g.vertexCount*20),short=new Uint16Array(g.indexCount);
 D.decodeVertexBuffer(bytes,g.vertexCount,20,vb);D.decodeIndexBuffer(new Uint8Array(short.buffer),g.indexCount,2,ib);
 const view=new DataView(bytes.buffer),p=new Float32Array(g.vertexCount*3),attr=new Float32Array(g.vertexCount*5),m=g.instances[0];
 for(let i=0;i<g.vertexCount;i++){
  const q=[0,1,2].map(a=>view.getUint16(i*20+a*2,true)/65535);
  for(let a=0;a<3;a++)p[i*3+a]=m[a]*q[0]+m[4+a]*q[1]+m[8+a]*q[2]+m[12+a];
  attr.set([view.getInt8(i*20+8)/127,view.getInt8(i*20+9)/127,view.getInt8(i*20+10)/127,view.getFloat32(i*20+12,true),view.getFloat32(i*20+16,true)],i*5);
 }
 // Convert the UV penalty to material texture coordinates. A conservative row
 // sum includes scale/shear/rotation; constants have no texture penalty.
 const maps=Object.values(textures.materials[g.material-1].maps);
 const uvScale=Math.max(0,...maps.flatMap(t=>[Math.abs(t.matrix[0])+Math.abs(t.matrix[1]),Math.abs(t.matrix[3])+Math.abs(t.matrix[4])]));
 const pages=splitPages(p,Uint32Array.from(short));
 for(const indices of pages){
  const fine=compactPage(bytes,indices),id=manifest.groups.length;
  const [simplified,error]=M.simplifyWithAttributes(indices,p,3,attr,5,[.02,.02,.02,.0002*uvScale,.0002*uvScale],null,Math.max(3,Math.floor(indices.length*.15/3)*3),.1,['Permissive','LockBorder','Sparse','ErrorAbsolute']);
  const coarse=compactPage(bytes,simplified.length?simplified:indices);
  // Only split into two resident representations when coarse saves >=15%.
  const useLOD=coarse.vertices.length+coarse.indices.byteLength < .85*(fine.vertices.length+fine.indices.byteLength);
  const base=await storePage(useLOD?coarse:fine,`part-${id}`),lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  for(const old of new Set(indices))for(let a=0;a<3;a++){const v=view.getUint16(old*20+a*2,true)/65535;lo[a]=Math.min(lo[a],v);hi[a]=Math.max(hi[a],v);}
  const n={...g,...base,bounds:[lo,hi]};baseBytes+=base.bytes;baseDownload+=base.downloadBytes;
  if(useLOD){const detail=await storePage(fine,`detail-${id}`);n.detail={...detail,errorWorld:Math.max(.1,error)};detailBytes+=detail.bytes;detailDownload+=detail.downloadBytes;}
  manifest.groups.push(n);stats.push({sourcePart,page:id,before:indices.length/3,after:base.indexCount/3,error,useLOD});
 }
 if(sourcePart%20===0)console.log(JSON.stringify({sourcePart,pages:manifest.groups.length,baseMB:baseBytes/1e6}));
}
for(const f of manifest.families)f.trianglesPerCopy=0;
const objects=new Map(manifest.objects.map(o=>{o.triangles=0;return[o.name,o];}));
for(const g of manifest.groups){manifest.families[g.family-1].trianglesPerCopy+=g.indexCount/3;for(const name of g.objects)objects.get(name).triangles+=g.indexCount/3;}
manifest.triangles=manifest.groups.reduce((s,g)=>s+g.indexCount/3*g.instances.length,0);
manifest.name='M8 — пространственная детализация';manifest.cropRule='All objects retained; spatial pages for metal families 184/201, attribute-aware coarse LOD, locked page boundaries, no component pruning';
manifest.paging={version:1,sourceDigest:hash(raw),referenceTriangles:source.triangles,families:[184,201],budgetBytes:48*1024*1024,baseBytes,detailBytes,baseDownload,detailDownload,method:'Spatial median triangle partition, meshoptimizer attribute LOD; 0.1 world-unit heuristic error floor; approximate, not a Hausdorff bound'};
manifest.lod={...source.lod,geometryBytes:baseBytes,downloadBytes:baseDownload};
const final=Buffer.from(JSON.stringify(manifest));textures.sourceDigest=hash(final);
await writeFile(new URL('scene.json',out),final);await writeFile(new URL('textures.json',out),JSON.stringify(textures));
await writeFile(new URL('preparation.json',out),JSON.stringify({stats,...manifest.paging},null,2));
console.log(JSON.stringify({objects:manifest.objects.length,groups:manifest.groups.length,detailPages:manifest.groups.filter(g=>g.detail).length,triangles:manifest.triangles,...manifest.paging}));
