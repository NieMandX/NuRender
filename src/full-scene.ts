import {fetchAsset as fetch} from './asset-fetch';
import {geometryBounds,transformedBounds,intersectsFrustum,type Bounds,type Plane} from './frustum';
import {orderedLoad} from './ordered-load';
import {assetUrl} from './asset-url';
import {MeshoptDecoder} from 'meshoptimizer/decoder';
import {classifyMaterialName,type ClassifiedGroup} from './material-classification';
import {assignMaterial,clearMaterials,type BatchData} from './batch';
import {exportMaterialPack,importMaterialPack} from './material-pack';
import {sourceDigest} from './structured-real';
import {loadTextureManifest,type TextureManifest} from './texture-assets';
export const FULL_ROOT=assetUrl('scenes/m8-full/');
export const MOBILE_ROOT=assetUrl('scenes/m8-mobile/');
export type FullFamily={id:number;object:string;materialName:string;copies:number;trianglesPerCopy:number;bounds:number[][]};
export type FullPart={name:string;family:number;material:number;color:number[];vertices:string;indices:string;vertexCount:number;indexCount:number;vertexDigest:string;indexDigest:string;instances:number[][];objects:string[]};
export type FullManifest={version:2;vertexFormat?:string;compression?:string;lod?:{geometryBytes:number;downloadBytes:number;originalTriangles:number};name:string;source:string;anchorObject:string;cropRule:string;materials:string;bounds:number[][];objects:{name:string;triangles:number}[];groups:FullPart[];families:FullFamily[];triangles:number};
export type FullChunk={meta:FullPart;vertices:Float32Array<ArrayBuffer>;indices:Uint32Array<ArrayBuffer>;elements:Float32Array<ArrayBuffer>;ids:number[]};
export function packFullChunks(chunks:FullChunk[]){
  const nv=chunks.reduce((n,c)=>n+c.meta.vertexCount,0),ne=chunks.reduce((n,c)=>n+c.meta.instances.length,0);
  if(nv>65536||ne>65536)throw new Error('Full batch exceeds 16-bit addresses');
  const vertices=new Float32Array(nv*8),elements=new Float32Array(ne*36),indices=new Uint32Array(chunks.reduce((n,c)=>n+c.indices.length,0)),addresses=new Uint32Array(chunks.reduce((n,c)=>n+c.indices.length*c.meta.instances.length,0));
  const bounds:Bounds[]=[];
  const ranges:{firstIndex:number;count:number;firstElement:number;copies:number}[]=[],ids:number[]=[];
  let vo=0,eo=0,io=0,bo=0;
  for(const c of chunks){
    vertices.set(c.vertices,vo*8);elements.set(c.elements,eo*36);ids.push(...c.ids);
    const local=geometryBounds(c.vertices);for(let copy=0;copy<c.meta.instances.length;copy++)bounds.push(transformedBounds(local,c.elements.subarray(copy*36,copy*36+16)));
    ranges.push({firstIndex:io,count:c.indices.length,firstElement:eo,copies:c.meta.instances.length});
    for(const index of c.indices)indices[io++]=vo+index;
    for(let copy=0;copy<c.meta.instances.length;copy++)for(const index of c.indices)addresses[bo++]=(((eo+copy)<<16)|(vo+index))>>>0;
    vo+=c.meta.vertexCount;eo+=c.meta.instances.length;
  }
  return {vertices,elements,indices,addresses,ranges,ids,bounds};
}
type FullBatch={bounds:Bounds[];visibility:Uint8Array;vertices:GPUBuffer;indices:GPUBuffer;addresses:GPUBuffer;elements:GPUBuffer;overrides:GPUBuffer;base:Float32Array<ArrayBuffer>;edited:Float32Array<ArrayBuffer>;ids:number[];ranges:ReturnType<typeof packFullChunks>['ranges'];addressCount:number;bind?:GPUBindGroup};
type Layer='opaque'|'glass'|'shadow';
export class FullScene{
  readonly batches:FullBatch[]=[];textures!:TextureManifest;classification:ClassifiedGroup[]=[];
  preparationMs=0;batching=true;readonly diagnostic=0;
  private catalog:BatchData={vertices:new Float32Array(),labels:new Uint32Array(),indices:new Uint32Array(),instances:new Float32Array(),materials:new Float32Array(),elements:[],texcoords:new Float32Array(),texcoordOffsets:new Uint32Array()};
  private owned:GPUBuffer[]=[];
  private constructor(readonly device:GPUDevice,readonly manifest:FullManifest,readonly materialIdentity:{sourceDigest:string;layoutDigest:string},readonly mobile=false){}
  static async load(device:GPUDevice,progress:(s:string)=>void=()=>{},mobile=false){
    const root=mobile?MOBILE_ROOT:FULL_ROOT;
    const r=await fetch(root+'scene.json');if(!r.ok)throw new Error('Полная сцена ещё не экспортирована');const raw=await r.text(),manifest:FullManifest=JSON.parse(raw);
    if(manifest.version!==2||!Array.isArray(manifest.groups)||!manifest.groups.length)throw new Error('Неподдерживаемый экспорт полной сцены');
    const digest=await sourceDigest([new TextEncoder().encode(raw)]),scene=new FullScene(device,manifest,{sourceDigest:digest,layoutDigest:await sourceDigest([new TextEncoder().encode(digest+':full-batch-v1')])},mobile);
    if(mobile&&(manifest.vertexFormat!=='unorm16x4-snorm8x4-float32x2'||manifest.compression!=='meshopt'))throw new Error('Invalid mobile geometry format');
    if(mobile)await MeshoptDecoder.ready;
    const started=performance.now();let chunks:FullChunk[]=[],vertices=0,elements=0;
    const flush=()=>{if(!chunks.length)return;scene.upload(packFullChunks(chunks));chunks=[];vertices=0;elements=0;};
    try{
      scene.textures=await loadTextureManifest(digest,root);
      const loaded=orderedLoad(manifest.groups,mobile?3:4,async(g,gi,signal)=>{
        if(!/^part-\d+\.vertices\.bin$/.test(g.vertices)||!/^part-\d+\.indices\.bin$/.test(g.indices))throw new Error('Неверный путь геометрии');
        const responses=await Promise.all([fetch(root+g.vertices,{signal}),fetch(root+g.indices,{signal})]);if(responses.some(r=>!r.ok))throw new Error('Неполная геометрия');
        const [vb,ib]=await Promise.all(responses.map(r=>r.arrayBuffer()));return {g,gi,vb,ib};
      });
      for await(const {g,gi,vb,ib} of loaded){
        progress(`Полная сцена: геометрия ${gi+1}/${manifest.groups.length}`);
        if(g.vertexCount>65536||g.vertexCount<1||g.indexCount%3||g.instances.length!==g.objects.length||!scene.textures.materials[g.material-1])throw new Error('Неверная часть полной сцены');
        if(!/^part-\d+\.vertices\.bin$/.test(g.vertices)||!/^part-\d+\.indices\.bin$/.test(g.indices))throw new Error('Неверный путь геометрии');
        if(await sourceDigest([new Uint8Array(vb)])!==g.vertexDigest||await sourceDigest([new Uint8Array(ib)])!==g.indexDigest)throw new Error('Повреждена геометрия '+g.name);
        let v=new Float32Array(),idx=new Uint32Array(),compact:Uint8Array<ArrayBuffer>|undefined,shortIndices:Uint16Array<ArrayBuffer>|undefined;
        if(mobile){
          compact=new Uint8Array(g.vertexCount*20);shortIndices=new Uint16Array(g.indexCount);
          MeshoptDecoder.decodeVertexBuffer(compact,g.vertexCount,20,new Uint8Array(vb));MeshoptDecoder.decodeIndexBuffer(new Uint8Array(shortIndices.buffer),g.indexCount,2,new Uint8Array(ib));
          if(shortIndices.some(i=>i>=g.vertexCount))throw new Error('Invalid mobile indices');
          const view=new DataView(compact.buffer);for(let at=0;at<g.vertexCount;at++)if(!Number.isFinite(view.getFloat32(at*20+12,true))||!Number.isFinite(view.getFloat32(at*20+16,true)))throw new Error('Invalid mobile UV');
        }else{
          if(vb.byteLength!==g.vertexCount*32||ib.byteLength!==g.indexCount*4)throw new Error('Повреждена геометрия '+g.name);
          v=new Float32Array(vb);idx=new Uint32Array(ib);if(!v.every(Number.isFinite)||idx.some(i=>i>=g.vertexCount))throw new Error('Неверные вершины или индексы');
        }
        const data=new Float32Array(g.instances.length*36),ids:number[]=[];
        const name=scene.textures.materials[g.material-1].name;
        for(const [copy,m] of g.instances.entries()){
          if(m.length!==28||!m.every(Number.isFinite))throw new Error('Неверная матрица объекта');
          const category=classifyMaterialName(name,[g.objects[copy],g.name]),id=scene.catalog.elements.length+1;
          data.set(m,copy*36);data[copy*36+19]=category.code;data[copy*36+23]=g.material;data.set([...g.color,1],copy*36+28);
          ids.push(id);scene.catalog.elements.push({id,family:g.family,copy,material:0});
          const classified=scene.classification.find(c=>c.name===g.objects[copy]&&c.materials[0].name===name);
          if(classified)classified.materials[0].triangles+=g.indexCount/3;
          else scene.classification.push({group:g.family,name:g.objects[copy],materials:[{name,classification:category,triangles:g.indexCount/3}]});
        }
        if(mobile){scene.uploadMobile(compact!,shortIndices!,data,ids);await device.queue.onSubmittedWorkDone();continue;}
        if(vertices+g.vertexCount>65536||elements+g.instances.length>65536)flush();
        chunks.push({meta:g,vertices:v,indices:idx,elements:data,ids});vertices+=g.vertexCount;elements+=g.instances.length;
      }
      flush();const count=scene.catalog.elements.length;
      if(count>65536)throw new Error('Too many material elements');
      scene.catalog.instances=new Float32Array(count*32);scene.catalog.materials=new Float32Array((count+1)*8);
      const triangles=manifest.groups.reduce((n,g)=>n+g.indexCount/3*g.instances.length,0);
      if(triangles!==manifest.triangles||triangles!==manifest.objects.reduce((n,o)=>n+o.triangles,0))throw new Error('Неполный учёт треугольников');
      scene.preparationMs=performance.now()-started;return scene;
    }catch(e){scene.destroy();throw e;}
  }
  private buffer(data:Float32Array<ArrayBuffer>|Uint32Array<ArrayBuffer>|Uint8Array<ArrayBuffer>|Uint16Array<ArrayBuffer>,usage:number,label:string){const b=this.device.createBuffer({size:Math.ceil(data.byteLength/4)*4,usage:usage|GPUBufferUsage.COPY_DST,label});this.owned.push(b);if(data.byteLength%4){const padded=new Uint8Array(Math.ceil(data.byteLength/4)*4);padded.set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength));this.device.queue.writeBuffer(b,0,padded);}else this.device.queue.writeBuffer(b,0,data);return b;}
  private upload(p:ReturnType<typeof packFullChunks>){
    this.batches.push({bounds:p.bounds,visibility:new Uint8Array(p.ids.length).fill(1),vertices:this.buffer(p.vertices,GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE,'Full shared vertices'),indices:this.buffer(p.indices,GPUBufferUsage.INDEX,'Full A/C indices'),addresses:this.buffer(p.addresses,GPUBufferUsage.INDEX,'Full B addresses'),elements:this.buffer(p.elements,GPUBufferUsage.VERTEX,'Full A/C transforms and materials'),overrides:this.buffer(p.elements,GPUBufferUsage.STORAGE,'Full B transforms and materials'),base:p.elements,edited:p.elements.slice(),ids:p.ids,ranges:p.ranges,addressCount:p.addresses.length});
  }
  private uploadMobile(vertices:Uint8Array<ArrayBuffer>,indices:Uint16Array<ArrayBuffer>,elements:Float32Array<ArrayBuffer>,ids:number[]){
    const index=this.buffer(indices,GPUBufferUsage.INDEX,'Mobile 16-bit indices');
    this.batches.push({bounds:ids.map((_,i)=>transformedBounds([[0,0,0],[1,1,1]],elements.subarray(i*36,i*36+16))),visibility:new Uint8Array(ids.length).fill(1),vertices:this.buffer(vertices,GPUBufferUsage.VERTEX,'Mobile packed vertices'),indices:index,addresses:index,elements:this.buffer(elements,GPUBufferUsage.VERTEX,'Mobile original materials'),overrides:this.buffer(elements,GPUBufferUsage.VERTEX,'Mobile editable materials'),base:elements,edited:elements.slice(),ids,ranges:[{firstIndex:0,count:indices.length,firstElement:0,copies:ids.length}],addressCount:0});
  }
  createBatchBind(layout:GPUBindGroupLayout){if(this.mobile)return;for(const b of this.batches)b.bind=this.device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:b.vertices}},{binding:1,resource:{buffer:b.overrides}}]});}
  get materialEdits(){return this.catalog.elements.filter(e=>e.material).length;}
  exportMaterials(){return exportMaterialPack(this.catalog,this.materialIdentity);}
  importMaterials(value:unknown){const n=importMaterialPack(value,this.catalog,this.materialIdentity);this.batching=true;this.updateMaterials();return n;}
  editMaterial(family:number,copy:number|null,color:number[],emission:number,roughness:number,metallic:number){const n=assignMaterial(this.catalog,family,copy,color,emission,roughness,metallic);this.batching=true;this.updateMaterials();return n;}
  resetMaterials(){clearMaterials(this.catalog);this.updateMaterials();}
  shadowVersion=0;private shadowOverrides='';
  private updateMaterials(){const overrides=(this.catalog).elements.filter(e=>e.material!==0).map(e=>e.id).join(',');if(overrides!==this.shadowOverrides){this.shadowVersion++;this.shadowOverrides=overrides;}for(const b of this.batches){b.edited.set(b.base);for(const [i,id] of b.ids.entries()){const e=this.catalog.elements[id-1];if(!e.material)continue;const p=this.catalog.materials.subarray(e.material*8,e.material*8+8);b.edited.set(p.subarray(0,4),i*36+28);b.edited.set([p[4],p[5],p[6],1],i*36+32);b.edited[i*36+19]=0;}this.device.queue.writeBuffer(b.overrides,0,b.edited);}}
  cullingInfo={enabled:false,testedInstances:0,rejectedInstances:0};
  private visibilityPlanes:Plane[]|null|undefined;
  prepareVisibility(planes:Plane[]|null){
    // Geometry/transforms are immutable after loading. Reuse visibility when only materials change.
    if(planes===null&&this.visibilityPlanes===null)return;
    if(planes&&this.visibilityPlanes&&planes.every((p,i)=>p.every((v,j)=>v===this.visibilityPlanes![i][j])))return;
    let rejected=0,tested=0;for(const b of this.batches)for(let i=0;i<b.ids.length;i++){const visible=!planes||intersectsFrustum(b.bounds[i],planes);b.visibility[i]=visible?1:0;tested++;if(!visible)rejected++;}
    this.visibilityPlanes=planes?.map(p=>[...p] as Plane)??null;
    this.cullingInfo={enabled:!!planes,testedInstances:tested,rejectedInstances:rejected};
  }
  private visible(data:Float32Array,start:number,count:number,layer:Layer,visibility:Uint8Array){for(let i=start;i<start+count;i++)if((layer==='shadow'||visibility[i])&&((data[i*36+19]===1)===(layer==='glass')))return true;return false;}
  draw(pass:GPURenderPassEncoder,mode:'A'|'B'|'C',layer:Layer){
    for(const b of this.batches){
      if(mode==='B'&&this.batching&&!this.mobile){if(!this.visible(b.edited,0,b.ids.length,layer,b.visibility))continue;pass.setBindGroup(2,b.bind!);pass.setIndexBuffer(b.addresses,'uint32');pass.drawIndexed(b.addressCount);continue;}
      const edited=mode==='B'&&this.mobile;const data=edited?b.edited:b.base;
      pass.setVertexBuffer(0,b.vertices);pass.setVertexBuffer(1,edited?b.overrides:b.elements);pass.setIndexBuffer(b.indices,this.mobile?'uint16':'uint32');
      for(const range of b.ranges){if(mode==='A'){for(let c=0;c<range.copies;c++)if(this.visible(data,range.firstElement+c,1,layer,b.visibility))pass.drawIndexed(range.count,1,range.firstIndex,0,range.firstElement+c);}
        else if(this.visible(data,range.firstElement,range.copies,layer,b.visibility))pass.drawIndexed(range.count,range.copies,range.firstIndex,0,range.firstElement);}
    }
  }
  drawCount(mode:'A'|'B'|'C',includeShadow=true){
    let count=1; // transparency composite
    for(const b of this.batches)for(const layer of (includeShadow?['shadow','opaque','glass']:['opaque','glass']) as Layer[]){
      if(mode==='B'&&this.batching&&!this.mobile){if(this.visible(b.edited,0,b.ids.length,layer,b.visibility))count++;}
      else for(const r of b.ranges){const data=mode==='B'&&this.mobile?b.edited:b.base;if(mode==='A'){for(let c=0;c<r.copies;c++)if(this.visible(data,r.firstElement+c,1,layer,b.visibility))count++;}else if(this.visible(data,r.firstElement,r.copies,layer,b.visibility))count++;}
    }return count;
  }
  get elementCount(){return this.catalog.elements.length;}
  get allocationBreakdown(){return this.batches.reduce((n,b)=>({commonVertices:n.commonVertices+b.vertices.size,ACIndices:n.ACIndices+b.indices.size,BAddresses:n.BAddresses+(this.mobile?0:b.addresses.size),ACInstances:n.ACInstances+b.elements.size,BInstances:n.BInstances+b.overrides.size}),{commonVertices:0,ACIndices:0,BAddresses:0,ACInstances:0,BInstances:0});}
  get bytes(){return this.batches.reduce((n,b)=>n+b.vertices.size+b.indices.size+b.elements.size,0);}
  get structuredBytes(){return this.mobile?this.bytes:this.batching?this.batches.reduce((n,b)=>n+b.vertices.size+b.addresses.size+b.overrides.size,0):this.bytes;}
  get residentBytes(){return this.owned.reduce((n,b)=>n+b.size,0);}
  get cpuBytes(){return this.batches.reduce((n,b)=>n+b.base.byteLength+b.edited.byteLength,0)+this.catalog.instances.byteLength+this.catalog.materials.byteLength;}
  destroy(){for(const b of this.owned)b.destroy();this.owned=[];this.batches.length=0;}
}
