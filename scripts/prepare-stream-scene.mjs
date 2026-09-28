// A small, explicitly approximate overview plus up to two streamed refinements.
// The finest pages retain every triangle of the existing mobile export.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {MeshoptDecoder as D,MeshoptEncoder as E,MeshoptSimplifier as M} from 'meshoptimizer';
import {splitPages,compactPage} from './spatial-pages.mjs';
const root=new URL('../public/scenes/m8-mobile/',import.meta.url),out=new URL('../public/scenes/m8-stream/',import.meta.url);
await mkdir(out,{recursive:true});await Promise.all([D.ready,E.ready,M.ready]);
const hash=b=>createHash('sha256').update(b).digest('hex');
const raw=await readFile(new URL('scene.json',root)),source=JSON.parse(raw),textures=JSON.parse(await readFile(new URL('textures.json',root)));
if(source.vertexFormat!=='unorm16x4-snorm8x4-float32x2'||textures.sourceDigest!==hash(raw))throw Error('Unexpected mobile source');
const manifest=structuredClone(source);manifest.groups=[];
const bootstrap=[],stats=[];let offset=0,baseBytes=0,detailBytes=0,detailDownload=0;
function encoded(page,prefix){
 const v=E.encodeVertexBuffer(page.vertices,page.count,20),i=E.encodeIndexBuffer(new Uint8Array(page.indices.buffer),page.indices.length,2);
 return {v,i,meta:{vertices:prefix+'.vertices.bin',indices:prefix+'.indices.bin',vertexCount:page.count,indexCount:page.indices.length,vertexDigest:hash(v),indexDigest:hash(i),bytes:page.vertices.length+Math.ceil(page.indices.byteLength/4)*4}};
}
async function detail(page,id,level,errorWorld){
 const {v,i,meta}=encoded(page,`detail-${id}-${level}`),data=Buffer.concat([v,i]),file=`detail-${id}-${level}.bin`;
 await writeFile(new URL(file,out),data);detailBytes+=meta.bytes;detailDownload+=data.length;
 return {...meta,errorWorld,packet:{file,bytes:data.length,vertexBytes:v.length,sha256:hash(data)}};
}
for(const [sourcePart,g] of source.groups.entries()){
 const vb=await readFile(new URL(g.vertices,root)),ib=await readFile(new URL(g.indices,root));
 if(hash(vb)!==g.vertexDigest||hash(ib)!==g.indexDigest)throw Error('Source hash mismatch');
 const bytes=new Uint8Array(g.vertexCount*20),short=new Uint16Array(g.indexCount);
 D.decodeVertexBuffer(bytes,g.vertexCount,20,vb);D.decodeIndexBuffer(new Uint8Array(short.buffer),g.indexCount,2,ib);
 const view=new DataView(bytes.buffer),p=new Float32Array(g.vertexCount*3),attr=new Float32Array(g.vertexCount*5);
 // A Frobenius bound works for all copies, including nonuniform scale/shear.
 // Using a common isotropic space avoids assuming the first instance is largest.
 const scale=Math.max(...g.instances.map(m=>Math.hypot(...[0,1,2,4,5,6,8,9,10].map(a=>m[a]))));
 for(let i=0;i<g.vertexCount;i++){
  for(let a=0;a<3;a++)p[i*3+a]=view.getUint16(i*20+a*2,true)/65535*scale;
  attr.set([view.getInt8(i*20+8)/127,view.getInt8(i*20+9)/127,view.getInt8(i*20+10)/127,view.getFloat32(i*20+12,true),view.getFloat32(i*20+16,true)],i*5);
 }
 const maps=Object.values(textures.materials[g.material-1].maps),uvScale=Math.max(0,...maps.flatMap(t=>[Math.abs(t.matrix[0])+Math.abs(t.matrix[1]),Math.abs(t.matrix[3])+Math.abs(t.matrix[4])]));
 for(const indices of splitPages(p,Uint32Array.from(short))){
  const id=manifest.groups.length,fine=compactPage(bytes,indices);
  const target=Math.min(indices.length,Math.max(36,Math.floor(indices.length*.03/3)*3));
  // Sloppy simplification can select any supplied vertex. Restrict its input to
  // this page so an overview cannot escape the page's culling bounds.
  const original=[...new Set(indices)],localPositions=Float32Array.from(original.flatMap(i=>[p[i*3],p[i*3+1],p[i*3+2]]));
  const [localOverview,error]=indices.length<=384?[Uint32Array.from(fine.indices),0]:M.simplifySloppy(Uint32Array.from(fine.indices),localPositions,3,null,target,.01);
  const overview=Uint32Array.from(localOverview,i=>original[i]);
  const coarse=compactPage(bytes,overview.length?overview:indices);
  const useLOD=coarse.vertices.length+coarse.indices.byteLength<.85*(fine.vertices.length+fine.indices.byteLength);
  const base=encoded(useLOD?coarse:fine,`part-${id}`),lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  for(const old of new Set(indices))for(let a=0;a<3;a++){const v=view.getUint16(old*20+a*2,true)/65535;lo[a]=Math.min(lo[a],v);hi[a]=Math.max(hi[a],v);}
  const n={...g,...base.meta,bounds:[lo,hi],packed:{offset,vertexBytes:base.v.length,indexBytes:base.i.length},levels:[]};
  bootstrap.push(base.v,base.i);offset+=base.v.length+base.i.length;baseBytes+=base.meta.bytes;
  if(useLOD){
   const coarseError=Math.max(.25,error*M.getScale(localPositions,3));
   const [midIndices,midError]=M.simplifyWithAttributes(indices,p,3,attr,5,[.02,.02,.02,.0002*uvScale,.0002*uvScale],null,Math.max(3,Math.floor(indices.length*.15/3)*3),.1,['Permissive','LockBorder','Sparse','ErrorAbsolute']);
   const middle=compactPage(bytes,midIndices.length?midIndices:indices);
   const midBytes=middle.vertices.length+middle.indices.byteLength,fineBytes=fine.vertices.length+fine.indices.byteLength;
   const useMiddle=midBytes<.85*fineBytes&&midBytes>1.2*base.meta.bytes;
   if(useMiddle)n.levels.push(await detail(middle,id,0,Math.max(coarseError,midError)));
   n.levels.push(await detail(fine,id,n.levels.length,useMiddle?Math.min(Math.max(.1,midError),coarseError):coarseError));
  }
  manifest.groups.push(n);stats.push({sourcePart,page:id,referenceTriangles:indices.length/3,baseTriangles:n.indexCount/3,levels:n.levels.length});
 }
 if(sourcePart%200===0)console.log(JSON.stringify({sourcePart,pages:manifest.groups.length,baseMB:baseBytes/1e6}));
}
for(const f of manifest.families)f.trianglesPerCopy=0;
const objects=new Map(manifest.objects.map(o=>{o.triangles=0;return[o.name,o];}));
for(const g of manifest.groups){manifest.families[g.family-1].trianglesPerCopy+=g.indexCount/3;for(const name of g.objects)objects.get(name).triangles+=g.indexCount/3;}
manifest.triangles=manifest.groups.reduce((s,g)=>s+g.indexCount/3*g.instances.length,0);
const pack=Buffer.concat(bootstrap);await writeFile(new URL('bootstrap.bin',out),pack);
manifest.name='M8 — потоковая сцена';manifest.cropRule='All objects retained; approximate overview with possible loss of thin components, seams and texture accuracy; finest pages exactly retain mobile source';
manifest.paging={version:2,sourceDigest:hash(raw),referenceTriangles:source.triangles,budgetBytes:48*1024*1024,baseBytes,detailBytes,baseDownload:pack.length,detailDownload,bootstrap:{file:'bootstrap.bin',bytes:pack.length,sha256:hash(pack)},method:'Spatial pages; approximate vertex-cluster overview, attribute-aware middle with locked boundaries, exact mobile fine pages. Screen error is a heuristic, not a certified Hausdorff bound.'};
manifest.lod={...source.lod,geometryBytes:baseBytes,downloadBytes:pack.length};
const final=Buffer.from(JSON.stringify(manifest));textures.sourceDigest=hash(final);
await writeFile(new URL('scene.json',out),final);await writeFile(new URL('textures.json',out),JSON.stringify(textures));
await writeFile(new URL('preparation.json',out),JSON.stringify({stats,...manifest.paging},null,2));
console.log(JSON.stringify({objects:manifest.objects.length,pages:manifest.groups.length,threeLevels:manifest.groups.filter(g=>g.levels.length===2).length,baseTriangles:manifest.triangles,...manifest.paging}));
