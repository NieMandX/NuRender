import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {findFamilies,type RepetitionReport} from '../src/repetitions.ts';
import {classifyVertices,type MaterialProvenance} from '../src/material-classification.ts';
const root=new URL('../public/scenes/m8-fragment/',import.meta.url);
const raw=await readFile(new URL('scene.json',root)),manifest=JSON.parse(raw.toString());
const provenance:MaterialProvenance=JSON.parse(await readFile(new URL('materials.json',root),'utf8'));
const hash=createHash('sha256').update(raw),start=performance.now();
const report:RepetitionReport={version:1,method:'Position-welded connected components; translation-only oriented triangle signatures plus corner verification. No semantic recognition or geometry replacement.',toleranceMetres:.001,minCopies:3,minTriangles:4,sourceDigest:'',analysisMs:0,families:[],groups:[],summary:{analysedTriangles:0,excludedTriangles:0,repeatedTriangles:0,repeatedComponents:0,families:0,coverage:0}};
const labels:Uint32Array[]=[];
for(const [gi,g] of manifest.groups.entries()){
  const vb=await readFile(new URL(g.vertices,root)),ib=await readFile(new URL(g.indices,root));hash.update(vb).update(ib);
  const v=new Float32Array(vb.buffer.slice(vb.byteOffset,vb.byteOffset+vb.byteLength)),idx=new Uint32Array(ib.buffer.slice(ib.byteOffset,ib.byteOffset+ib.byteLength));
  const metadata=provenance.groups[gi],sb=await readFile(new URL(metadata.vertexSlots,root));
  classifyVertices(v,idx,new Uint32Array(sb.buffer.slice(sb.byteOffset,sb.byteOffset+sb.byteLength)),metadata.materialNames,[...g.objects,g.name]);
  // Already-shared objects and vegetation are deliberately excluded: this stage
  // measures newly discovered repetition inside merged meshes.
  const excluded=g.instances.length!==1||g.name.startsWith('M8_Tree');
  const result=excluded?{parts:[],families:[]}:findFamilies(v,idx,g.instances[0],gi,g.objects[0]);
  const map=new Uint32Array(g.vertexCount);labels.push(map);
  report.groups.push({labels:`group-${gi}.families.bin`,vertexCount:g.vertexCount,components:result.parts.length,excluded});
  report.summary[excluded?'excludedTriangles':'analysedTriangles']+=g.indexCount/3*g.instances.length;
  for(const f of result.families){f.id=report.families.length+1;report.families.push(f);for(const c of f.members)for(const t of c.triangles)for(let k=0;k<3;k++)map[idx[t*3+k]]=f.id;}
}
report.sourceDigest=hash.digest('hex');report.analysisMs=performance.now()-start;
if(provenance.sourceDigest!==report.sourceDigest)throw new Error('Material provenance is stale');
report.summary.families=report.families.length;
report.summary.repeatedComponents=report.families.reduce((n,f)=>n+f.copies,0);
report.summary.repeatedTriangles=report.families.reduce((n,f)=>n+f.copies*f.trianglesPerCopy,0);
report.summary.coverage=report.summary.repeatedTriangles/report.summary.analysedTriangles;
for(const [i,l] of labels.entries())await writeFile(new URL(report.groups[i].labels,root),new Uint8Array(l.buffer));
await writeFile(new URL('repetitions.json',root),JSON.stringify(report));
console.log(JSON.stringify({summary:report.summary,analysisMs:report.analysisMs,top:report.families.toSorted((a,b)=>b.copies*b.trianglesPerCopy-a.copies*a.trianglesPerCopy).slice(0,12).map(({members,...f})=>f)},null,2));
