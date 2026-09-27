import {components,type Family} from './repetitions';
export type PackedMesh={vertices:Float32Array<ArrayBuffer>;indices:Uint32Array<ArrayBuffer>;instances:Float32Array<ArrayBuffer>;labels:Uint32Array<ArrayBuffer>;family:number;sourceTriangles:number[];textureCopies?:Float32Array<ArrayBuffer>};
/** First executable decomposition: ordinary submesh instancing, without novel GPU decoding. */
export function packGroup(vertices:Float32Array,indices:Uint32Array,transform:number[],families:Family[]):PackedMesh[]{
  if(transform.length!==28)throw new Error('Expected a 28-float object transform');
  // Old reports may have been built before material names were available.
  // Do not reuse one template across differently classified source surfaces.
  const codes=new Set<number>();for(let i=9;i<vertices.length;i+=10)codes.add(vertices[i]);
  if(families.length&&codes.size>1){
    const signatures=new Map(components(vertices,indices,transform).map(c=>[c.triangles[0],c.signature]));
    for(const f of families){const signature=signatures.get(f.members[0].triangles[0]);if(!signature||f.members.some(m=>signatures.get(m.triangles[0])!==signature))throw new Error('Разбор объединяет разные материалы. Запустите npm run analyse.');}
  }
  const used=new Uint8Array(indices.length/3),out:PackedMesh[]=[];
  const compact=(triangles:number[],family:number,instances:number[])=>{
    const remap=new Map<number,number>(),data:number[]=[],idx:number[]=[];
    for(const t of triangles)for(let k=0;k<3;k++){
      const old=indices[t*3+k];let id=remap.get(old);
      if(id===undefined){id=remap.size;remap.set(old,id);for(let a=0;a<10;a++)data.push(vertices[old*10+a]);}
      idx.push(id);
    }
    out.push({vertices:new Float32Array(data),indices:new Uint32Array(idx),instances:new Float32Array(instances),labels:new Uint32Array(remap.size).fill(family),family,sourceTriangles:triangles});
  };
  for(const f of families){
    if(f.members.length!==f.copies||f.copies<3)throw new Error('Invalid family copy count');
    const transforms:number[]=[];
    for(const member of f.members){
      if(member.triangles.length!==f.trianglesPerCopy||member.translation.length!==3||!member.translation.every(Number.isFinite))throw new Error('Invalid family member');
      for(const t of member.triangles){if(!Number.isInteger(t)||t<0||t>=used.length||used[t])throw new Error('Overlapping or invalid family triangles');used[t]=1;}
      const m=transform.slice();for(let a=0;a<3;a++)m[12+a]+=member.translation[a];transforms.push(...m);
    }
    if(f.members[0].translation.some(v=>v!==0))throw new Error('Template translation must be zero');
    compact(f.members[0].triangles,f.id,transforms);
  }
  const residual:number[]=[];for(let t=0;t<used.length;t++)if(!used[t])residual.push(t);
  if(residual.length)compact(residual,0,transform);
  return out;
}
export async function sourceDigest(chunks:Uint8Array[]){
  const bytes=new Uint8Array(chunks.reduce((n,c)=>n+c.byteLength,0));let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.byteLength;}
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));return [...hash].map(x=>x.toString(16).padStart(2,'0')).join('');
}
