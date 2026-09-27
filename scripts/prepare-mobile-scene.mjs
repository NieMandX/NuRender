// Offline LOD. Full-resolution source assets remain unchanged.
import {compactMobile} from './mobile-codec.mjs';
import {MeshoptSimplifier as M,MeshoptEncoder as E} from 'meshoptimizer';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../public/scenes/m8-full/',import.meta.url),out=new URL('../public/scenes/m8-mobile/',import.meta.url);await mkdir(out,{recursive:true});await M.ready;await E.ready;
const digest=b=>createHash('sha256').update(b).digest('hex');const sourceRaw=await readFile(new URL('scene.json',root)),source=JSON.parse(sourceRaw);const manifest=structuredClone(source);let bytes=0,downloadBytes=0,sourceBytes=0;const stats=[];
for(const [at,g] of manifest.groups.entries()){
 const [vb,ib]=await Promise.all([readFile(new URL(g.vertices,root)),readFile(new URL(g.indices,root))]);sourceBytes+=vb.length+ib.length;
 const v=new Float32Array(vb.buffer,vb.byteOffset,vb.length/4),idx=new Uint32Array(ib.buffer,ib.byteOffset,ib.length/4);const attr=new Float32Array(g.vertexCount*5);for(let n=0;n<g.vertexCount;n++)attr.set(v.subarray(n*8+3,n*8+8),n*5);
 // Do not prune disconnected components or open cracks across source chunk borders.
 let [indices,error]=M.simplifyWithAttributes(idx,v,8,attr,5,[.002,.002,.002,.0002,.0002],null,Math.max(3,Math.floor(idx.length*.15/3)*3),.005,['Permissive','LockBorder']);
 if(!indices.length){indices=idx.slice();error=0;}
 const [remap,count]=M.compactMesh(indices),vertices=new Float32Array(count*8);
 for(let old=0;old<remap.length;old++)if(remap[old]!==0xffffffff)vertices.set(v.subarray(old*8,old*8+8),remap[old]*8);
 const compact=compactMobile(vertices,indices,g.instances);
 const vout=E.encodeVertexBuffer(compact.vertices,compact.count,20),iout=E.encodeIndexBuffer(new Uint8Array(compact.indices.buffer),indices.length,2);
 g.instances=compact.instances;g.vertexCount=compact.count;g.indexCount=indices.length;g.vertexDigest=digest(vout);g.indexDigest=digest(iout);bytes+=compact.vertices.length+compact.indices.byteLength;downloadBytes+=vout.length+iout.length;
 await Promise.all([writeFile(new URL(g.vertices,out),vout),writeFile(new URL(g.indices,out),iout)]);stats.push({part:at,trianglesBefore:idx.length/3,trianglesAfter:indices.length/3,error,maxWorldPositionError:compact.maxWorldPositionError,maxNormalError:compact.maxNormalError});
 if(at%100===0)console.log('LOD',at,'/',manifest.groups.length,'MiB',(bytes/1048576).toFixed(1));
}
const objects=new Map(manifest.objects.map(o=>[o.name,o]));for(const o of objects.values())o.triangles=0;
for(const f of manifest.families)f.trianglesPerCopy=0;
for(const g of manifest.groups){manifest.families[g.family-1].trianglesPerCopy+=g.indexCount/3;for(const name of g.objects)objects.get(name).triangles+=g.indexCount/3;}
manifest.triangles=manifest.groups.reduce((n,g)=>n+g.indexCount/3*g.instances.length,0);manifest.name='M8 — мобильная детализация';manifest.cropRule='all visible objects; offline attribute-aware simplification; locked part borders; no component pruning';manifest.lod={sourceDigest:digest(sourceRaw),originalTriangles:source.triangles,method:'meshoptimizer 1.3.0 simplifyWithAttributes, Permissive + LockBorder',targetRatio:.15,maxRelativeError:.005,geometryBytes:bytes,downloadBytes,maxWorldPositionError:Math.max(...stats.map(s=>s.maxWorldPositionError)),maxNormalError:Math.max(...stats.map(s=>s.maxNormalError))};
manifest.vertexFormat='unorm16x4-snorm8x4-float32x2';manifest.compression='meshopt';
const raw=Buffer.from(JSON.stringify(manifest));await writeFile(new URL('scene.json',out),raw);
const textures=JSON.parse(await readFile(new URL('textures.json',root),'utf8'));textures.sourceDigest=digest(raw);await writeFile(new URL('textures.json',out),JSON.stringify(textures));
await writeFile(new URL('preparation.json',out),JSON.stringify({sourceBytes,geometryBytes:bytes,downloadBytes,trianglesBefore:source.triangles,trianglesAfter:manifest.triangles,stats},null,2));
console.log(JSON.stringify({geometryBytes:bytes,downloadBytes,triangles:manifest.triangles,objects:manifest.objects.length,ratio:manifest.triangles/source.triangles}));
