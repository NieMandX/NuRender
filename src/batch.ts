import type {PackedMesh} from './structured-real';
export type BatchElement={id:number;family:number;copy:number;material:number};
export function makeBatch(meshes:PackedMesh[]){
  const families=meshes.filter(m=>m.family>0);
  const vertexCount=families.reduce((n,m)=>n+m.vertices.length/10,0),elementCount=families.reduce((n,m)=>n+m.instances.length/28,0);
  if(vertexCount>65536||elementCount>65536)throw new Error('Batch exceeds 16-bit vertex/element address space');
  const vertices=new Float32Array(vertexCount*10),labels=new Uint32Array(vertexCount);
  const instances=new Float32Array(elementCount*32),ids=new Uint32Array(instances.buffer);
  const indices=new Uint32Array(families.reduce((n,m)=>n+m.indices.length*m.instances.length/28,0));
  const materials=new Float32Array((elementCount+1)*8),elements:BatchElement[]=[];
  const texcoords=new Float32Array(families.reduce((n,m)=>n+m.vertices.length/10*m.instances.length/28*4,0)),texcoordOffsets=new Uint32Array(elementCount*2);
  let vo=0,eo=0,io=0,to=0;
  for(const mesh of families){
    vertices.set(mesh.vertices,vo*10);labels.fill(mesh.family,vo,vo+mesh.vertices.length/10);
    for(let copy=0;copy<mesh.instances.length/28;copy++){
      const count=mesh.vertices.length/10;texcoordOffsets.set([to,vo],eo*2);
      if(mesh.textureCopies)texcoords.set(mesh.textureCopies.subarray(copy*count*4,(copy+1)*count*4),to*4);to+=count;
      const id=eo+1;instances.set(mesh.instances.subarray(copy*28,(copy+1)*28),eo*32);
      ids.set([id,0,mesh.family,copy],eo*32+28);elements.push({id,family:mesh.family,copy,material:0});
      for(const v of mesh.indices)indices[io++]=((eo<<16)|(vo+v))>>>0;
      eo++;
    }
    vo+=mesh.vertices.length/10;
  }
  return {vertices,labels,instances,indices,materials,elements,texcoords,texcoordOffsets};
}
export type BatchData=ReturnType<typeof makeBatch>;
export function assignMaterial(batch:BatchData,family:number,copy:number|null,color:number[],emission:number,roughness=.7,metallic=0){
  if(color.length!==3||color.some(x=>!Number.isFinite(x)||x<0||x>1)||!Number.isFinite(emission)||emission<0||emission>2)throw new Error('Invalid material values');
  if(!Number.isFinite(roughness)||roughness<.05||roughness>1||!Number.isFinite(metallic)||metallic<0||metallic>1)throw new Error('Invalid PBR values');
  const selected=batch.elements.filter(e=>e.family===family&&(copy===null||e.copy===copy));
  if(!selected.length)throw new Error('No matching elements');
  const ids=new Uint32Array(batch.instances.buffer);
  for(const e of selected){e.material=e.id;ids[(e.id-1)*32+29]=e.id;batch.materials.set([...color,1,emission,roughness,metallic,0],e.id*8);}
  return selected.length;
}
export function clearMaterials(batch:BatchData){batch.materials.fill(0);const ids=new Uint32Array(batch.instances.buffer);for(const e of batch.elements){e.material=0;ids[(e.id-1)*32+29]=0;}}
