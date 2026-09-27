import type {Component,Family} from './repetitions';
import type {PackedMesh} from './structured-real';

/** Split only UV/material seams. A template retains separate attributes for each copy. */
export function withTextureCoordinates(mesh:PackedMesh,corners:Float32Array,family?:Family,parts?:Map<number,Component>):PackedMesh {
  const copies=family?.copies??1;
  const source=mesh.sourceTriangles.flatMap(t=>[t*3,t*3+1,t*3+2]);
  const correspondence:number[][]=[source];
  if(family){
    const template=parts?.get(family.members[0].triangles[0]);
    if(!template)throw new Error('Missing texture template correspondence');
    const order=new Map(template.canonicalCorners.map((corner,i)=>[corner,i]));
    for(const member of family.members.slice(1)){
      const part=parts!.get(member.triangles[0]);
      if(!part||part.signature!==template.signature)throw new Error('Texture copies do not match template');
      correspondence.push(source.map(c=>part.canonicalCorners[order.get(c)!]));
    }
  }
  const remap=new Map<string,number>(),vertices:number[]=[],labels:number[]=[],indices=new Uint32Array(mesh.indices.length);
  const attrs:number[][]=Array.from({length:copies},()=>[]);
  for(let i=0;i<source.length;i++){
    const old=mesh.indices[i],values=correspondence.map(cs=>Array.from(corners.subarray(cs[i]*4,cs[i]*4+4)));
    if(values.some(v=>v.length!==4||v.some(x=>!Number.isFinite(x))))throw new Error('Invalid texture corner');
    const key=old+':'+values.flat().join(',');let id=remap.get(key);
    if(id===undefined){
      id=remap.size;remap.set(key,id);vertices.push(...mesh.vertices.subarray(old*10,old*10+10));labels.push(mesh.labels[old]);
      for(let copy=0;copy<copies;copy++)attrs[copy].push(...values[copy]);
    }
    indices[i]=id;
  }
  return {...mesh,vertices:new Float32Array(vertices),indices,labels:new Uint32Array(labels),textureCopies:new Float32Array(attrs.flat())};
}
