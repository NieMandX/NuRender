import {fetchAsset as fetch} from './asset-fetch';
import {geometryBounds,transformedBounds,intersectsFrustum,type Bounds,type Plane} from './frustum';
import {orderedLoad} from './ordered-load';
import {validatePackRanges,slicePack,selectDetailLevel,type PackedRange,type GeometryPacket,type Bootstrap} from './stream-layout';
import {PageCache,projectedError,type PageRequest} from './page-cache';
import {assetUrl} from './asset-url';
import {MeshoptDecoder} from 'meshoptimizer/decoder';
import {classifyMaterialName,type ClassifiedGroup} from './material-classification';
import {assignMaterial,clearMaterials,type BatchData} from './batch';
import {exportMaterialPack,importMaterialPack} from './material-pack';
import {sourceDigest} from './structured-real';
import {loadTextureManifest,type TextureManifest} from './texture-assets';
export const FULL_ROOT=assetUrl('scenes/m8-full/');
export const MOBILE_ROOT=assetUrl('scenes/m8-mobile/');
export const PAGED_ROOT=assetUrl('scenes/m8-paged/');
export const STREAM_ROOT=assetUrl('scenes/m8-stream/');
type DetailPage={vertices:string;indices:string;vertexCount:number;indexCount:number;vertexDigest:string;indexDigest:string;bytes:number;errorWorld:number;packet?:GeometryPacket};
export type FullFamily={id:number;object:string;materialName:string;copies:number;trianglesPerCopy:number;bounds:number[][]};
export type FullPart={name:string;family:number;material:number;color:number[];vertices:string;indices:string;vertexCount:number;indexCount:number;vertexDigest:string;indexDigest:string;instances:number[][];objects:string[];bounds?:Bounds;detail?:DetailPage;levels?:DetailPage[];packed?:PackedRange};
export type FullManifest={version:2;vertexFormat?:string;compression?:string;lod?:{geometryBytes:number;downloadBytes:number;originalTriangles:number};paging?:{version:1|2;budgetBytes:number;referenceTriangles:number;sourceDigest:string;bootstrap?:Bootstrap};name:string;source:string;anchorObject:string;cropRule:string;materials:string;bounds:number[][];objects:{name:string;triangles:number}[];groups:FullPart[];families:FullFamily[];triangles:number};
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
type FullBatch={vertexOffset?:number;vertexBytes?:number;indexOffset?:number;indexBytes?:number;elementOffset?:number;elementBytes?:number;bounds:Bounds[];visibility:Uint8Array;vertices:GPUBuffer;indices:GPUBuffer;addresses:GPUBuffer;elements:GPUBuffer;overrides:GPUBuffer;base:Float32Array<ArrayBuffer>;edited:Float32Array<ArrayBuffer>;ids:number[];ranges:ReturnType<typeof packFullChunks>['ranges'];addressCount:number;bind?:GPUBindGroup};
type Layer='opaque'|'glass'|'shadow';
export class FullScene{
  readonly batches:FullBatch[]=[];textures!:TextureManifest;classification:ClassifiedGroup[]=[];
  preparationMs=0;batching=true;readonly diagnostic=0;
  private catalog:BatchData={vertices:new Float32Array(),labels:new Uint32Array(),indices:new Uint32Array(),instances:new Float32Array(),materials:new Float32Array(),elements:[],texcoords:new Float32Array(),texcoordOffsets:new Uint32Array()};
  private owned:GPUBuffer[]=[];
  private arena?:{vertices:GPUBuffer;indices:GPUBuffer;elements:GPUBuffer;overrides:GPUBuffer;vertexOffset:number;indexOffset:number;elementOffset:number};
  private pageCache?:PageCache<{vertices:GPUBuffer;indices:GPUBuffer;count:number;bytes:number;destroy():void}>;
  detailEnabled=true;streamingFrozen=false;onPageChange=()=>{};
  private visibilityVersion=0;private pageVersion=0;private materialVersion=0;
  bundleStamp(shadow:boolean){return shadow?String(this.materialVersion):`${this.materialVersion}:${this.visibilityVersion}:${this.pageVersion}`;}
  private levels(g:FullPart){return g.levels??(g.detail?[g.detail]:[]);}
  private selectedPage(id:number){return this.pageCache?.get(id*2+1)??this.pageCache?.get(id*2);}
  get pagingInfo(){
    if(!this.pageCache)return undefined;
    const activeLevels=[0,0,0];for(let id=0;id<this.manifest.groups.length;id++)activeLevels[this.pageCache.get(id*2+1)?2:this.pageCache.get(id*2)?(this.levels(this.manifest.groups[id]).length===1?2:1):0]++;
    return {...this.pageCache.info,version:this.manifest.paging!.version,enabled:this.detailEnabled,totalPages:this.manifest.groups.reduce((n,g)=>n+this.levels(g).length,0),activeLevels,baseTriangles:this.manifest.triangles,referenceTriangles:this.manifest.paging!.referenceTriangles};
  }
  private constructor(readonly device:GPUDevice,readonly manifest:FullManifest,readonly materialIdentity:{sourceDigest:string;layoutDigest:string},readonly mobile=false){}
  static async load(device:GPUDevice,progress:(s:string)=>void=()=>{},mobile=false,paged:boolean|'stream'=false){
    const root=mobile?(paged==='stream'?STREAM_ROOT:paged?PAGED_ROOT:MOBILE_ROOT):FULL_ROOT;
    const r=await fetch(root+'scene.json');if(!r.ok)throw new Error('Полная сцена ещё не экспортирована');const raw=await r.text(),manifest:FullManifest=JSON.parse(raw);
    if(manifest.version!==2||!Array.isArray(manifest.groups)||!manifest.groups.length)throw new Error('Неподдерживаемый экспорт полной сцены');
    const digest=await sourceDigest([new TextEncoder().encode(raw)]),scene=new FullScene(device,manifest,{sourceDigest:digest,layoutDigest:await sourceDigest([new TextEncoder().encode(digest+':full-batch-v1')])},mobile);
    if(mobile&&(manifest.vertexFormat!=='unorm16x4-snorm8x4-float32x2'||manifest.compression!=='meshopt'))throw new Error('Invalid mobile geometry format');
    if(mobile)await MeshoptDecoder.ready;
    if(paged&&(!mobile||![1,2].includes(manifest.paging?.version??0)))throw new Error('Неподдерживаемые пространственные страницы');
    const started=performance.now();let chunks:FullChunk[]=[],vertices=0,elements=0;
    const flush=()=>{if(!chunks.length)return;scene.upload(packFullChunks(chunks));chunks=[];vertices=0;elements=0;};
    try{
      scene.textures=await loadTextureManifest(digest,root);
      let bootstrap:ArrayBuffer|undefined;
      if(manifest.paging?.version===2){
        const b=manifest.paging.bootstrap;
        if(!b||b.file!=='bootstrap.bin'||!/^[a-f0-9]{64}$/.test(b.sha256))throw Error('Invalid bootstrap manifest');
        validatePackRanges(manifest.groups,b.bytes);
        for(const g of manifest.groups)if(!Number.isSafeInteger(g.vertexCount)||g.vertexCount<1||g.vertexCount>65536||!Number.isSafeInteger(g.indexCount)||g.indexCount<3||g.indexCount%3||!Array.isArray(g.instances)||g.instances.length<1||g.instances.length>65536)throw Error('Invalid bootstrap geometry');
        if(manifest.groups.reduce((n,g)=>n+g.vertexCount*20+g.indexCount*2,0)>128*1024*1024)throw Error('Bootstrap exceeds decoded budget');
        progress('Загрузка обзорной геометрии…');
        const response=await fetch(root+b.file);if(!response.ok)throw Error('Нет обзорной геометрии');bootstrap=await response.arrayBuffer();
        if(bootstrap.byteLength!==b.bytes||await sourceDigest([new Uint8Array(bootstrap)])!==b.sha256)throw Error('Повреждён обзорный пакет');
        scene.createArena();
      }
      const loaded=orderedLoad(manifest.groups,mobile?3:4,async(g,gi,signal)=>{
        if(!/^part-\d+\.vertices\.bin$/.test(g.vertices)||!/^part-\d+\.indices\.bin$/.test(g.indices))throw new Error('Неверный путь геометрии');
        if(bootstrap)return {g,gi,...slicePack(bootstrap,g.packed!)};
        const responses=await Promise.all([fetch(root+g.vertices,{signal}),fetch(root+g.indices,{signal})]);if(responses.some(r=>!r.ok))throw new Error('Неполная геометрия');
        const [vb,ib]=await Promise.all(responses.map(r=>r.arrayBuffer()));return {g,gi,vb,ib};
      });
      for await(const {g,gi,vb,ib} of loaded){
        progress(`Полная сцена: геометрия ${gi+1}/${manifest.groups.length}`);
        if(!Number.isSafeInteger(g.vertexCount)||!Number.isSafeInteger(g.indexCount)||g.indexCount<3||g.vertexCount>65536||g.vertexCount<1||g.indexCount%3||g.instances.length!==g.objects.length||!scene.textures.materials[g.material-1])throw new Error('Неверная часть полной сцены');
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
        if(mobile){
          if(g.bounds&&(!Array.isArray(g.bounds)||g.bounds.length!==2||g.bounds.some(v=>v.length!==3||!v.every(Number.isFinite))||g.bounds[0].some((v,a)=>v<0||v>g.bounds![1][a]||g.bounds![1][a]>1)))throw new Error('Invalid page bounds');
          scene.uploadMobile(compact!,shortIndices!,data,ids,g.bounds);if(!bootstrap||gi%32===31)await device.queue.onSubmittedWorkDone();continue;
        }
        if(vertices+g.vertexCount>65536||elements+g.instances.length>65536)flush();
        chunks.push({meta:g,vertices:v,indices:idx,elements:data,ids});vertices+=g.vertexCount;elements+=g.instances.length;
      }
      flush();await device.queue.onSubmittedWorkDone();bootstrap=undefined;const count=scene.catalog.elements.length;
      if(count>65536)throw new Error('Too many material elements');
      scene.catalog.instances=new Float32Array(count*32);scene.catalog.materials=new Float32Array((count+1)*8);
      const triangles=manifest.groups.reduce((n,g)=>n+g.indexCount/3*g.instances.length,0);
      if(triangles!==manifest.triangles||triangles!==manifest.objects.reduce((n,o)=>n+o.triangles,0))throw new Error('Неполный учёт треугольников');
      if(manifest.paging){
        if(!mobile||manifest.paging.budgetBytes!==48*1024*1024)throw new Error('Invalid page budget');
        for(const g of manifest.groups){
          const levels=scene.levels(g);if(levels.length>2||(g.detail&&g.levels))throw Error('Invalid LOD chain');
          let previousError=Infinity;
          for(const d of levels){
            if(!Number.isSafeInteger(d.vertexCount)||d.vertexCount<1||d.vertexCount>65536||!Number.isSafeInteger(d.indexCount)||d.indexCount<3||d.indexCount>196608||d.indexCount%3||d.bytes!==d.vertexCount*20+Math.ceil(d.indexCount*2/4)*4||!Number.isFinite(d.errorWorld)||d.errorWorld<=0||d.errorWorld>previousError||!/^detail-\d+(?:-\d)?\.vertices\.bin$/.test(d.vertices)||!/^detail-\d+(?:-\d)?\.indices\.bin$/.test(d.indices)||!g.bounds)throw new Error('Invalid detail page');
            previousError=d.errorWorld;
            if(d.packet){const p=d.packet;if(!/^detail-\d+-[01]\.bin$/.test(p.file)||!Number.isSafeInteger(p.bytes)||p.bytes<2||p.bytes>4*1024*1024||!Number.isSafeInteger(p.vertexBytes)||p.vertexBytes<1||p.vertexBytes>=p.bytes||!/^[a-f0-9]{64}$/.test(p.sha256))throw Error('Invalid detail packet');}
          }
        }
        scene.pageCache=new PageCache(manifest.paging.budgetBytes,(id,signal)=>scene.loadDetail(root,id,signal),()=>{scene.pageVersion++;scene.onPageChange();});
      }
      scene.preparationMs=performance.now()-started;return scene;
    }catch(e){scene.destroy();throw e;}
  }
  private buffer(data:Float32Array<ArrayBuffer>|Uint32Array<ArrayBuffer>|Uint8Array<ArrayBuffer>|Uint16Array<ArrayBuffer>,usage:number,label:string){const b=this.device.createBuffer({size:Math.ceil(data.byteLength/4)*4,usage:usage|GPUBufferUsage.COPY_DST,label});this.owned.push(b);if(data.byteLength%4){const padded=new Uint8Array(Math.ceil(data.byteLength/4)*4);padded.set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength));this.device.queue.writeBuffer(b,0,padded);}else this.device.queue.writeBuffer(b,0,data);return b;}
  private upload(p:ReturnType<typeof packFullChunks>){
    this.batches.push({bounds:p.bounds,visibility:new Uint8Array(p.ids.length).fill(1),vertices:this.buffer(p.vertices,GPUBufferUsage.VERTEX|GPUBufferUsage.STORAGE,'Full shared vertices'),indices:this.buffer(p.indices,GPUBufferUsage.INDEX,'Full A/C indices'),addresses:this.buffer(p.addresses,GPUBufferUsage.INDEX,'Full B addresses'),elements:this.buffer(p.elements,GPUBufferUsage.VERTEX,'Full A/C transforms and materials'),overrides:this.buffer(p.elements,GPUBufferUsage.STORAGE,'Full B transforms and materials'),base:p.elements,edited:p.elements.slice(),ids:p.ids,ranges:p.ranges,addressCount:p.addresses.length});
  }
  private createArena(){
    const sizes=this.manifest.groups.reduce((n,g)=>[n[0]+g.vertexCount*20,n[1]+Math.ceil(g.indexCount*2/4)*4,n[2]+g.instances.length*144],[0,0,0]);
    if(sizes[2]>65536*144)throw Error('Too many stream instances');
    const allocate=(size:number,usage:number,label:string)=>{const b=this.device.createBuffer({size,usage:usage|GPUBufferUsage.COPY_DST,label});this.owned.push(b);return b;};
    this.arena={vertices:allocate(sizes[0],GPUBufferUsage.VERTEX,'Stream overview vertex arena'),indices:allocate(sizes[1],GPUBufferUsage.INDEX,'Stream overview index arena'),elements:allocate(sizes[2],GPUBufferUsage.VERTEX,'Stream original instances'),overrides:allocate(sizes[2],GPUBufferUsage.VERTEX,'Stream editable instances'),vertexOffset:0,indexOffset:0,elementOffset:0};
  }
  private uploadMobile(vertices:Uint8Array<ArrayBuffer>,indices:Uint16Array<ArrayBuffer>,elements:Float32Array<ArrayBuffer>,ids:number[],bounds:Bounds=[[0,0,0],[1,1,1]]){
    const vertexBytes=vertices.byteLength,indexBytes=Math.ceil(indices.byteLength/4)*4,elementBytes=elements.byteLength,a=this.arena;
    let v:GPUBuffer,index:GPUBuffer,original:GPUBuffer,overrides:GPUBuffer;
    if(a){
      v=a.vertices;index=a.indices;original=a.elements;overrides=a.overrides;
      const padded=new Uint8Array(indexBytes);padded.set(new Uint8Array(indices.buffer,indices.byteOffset,indices.byteLength));
      this.device.queue.writeBuffer(v,a.vertexOffset,vertices);this.device.queue.writeBuffer(index,a.indexOffset,padded);
      this.device.queue.writeBuffer(original,a.elementOffset,elements);this.device.queue.writeBuffer(overrides,a.elementOffset,elements);
    }else{v=this.buffer(vertices,GPUBufferUsage.VERTEX,'Mobile packed vertices');index=this.buffer(indices,GPUBufferUsage.INDEX,'Mobile 16-bit indices');original=this.buffer(elements,GPUBufferUsage.VERTEX,'Mobile original materials');overrides=this.buffer(elements,GPUBufferUsage.VERTEX,'Mobile editable materials');}
    this.batches.push({vertexOffset:a?.vertexOffset??0,indexOffset:a?.indexOffset??0,elementOffset:a?.elementOffset??0,vertexBytes,indexBytes,elementBytes,bounds:ids.map((_,i)=>transformedBounds(bounds,elements.subarray(i*36,i*36+16))),visibility:new Uint8Array(ids.length).fill(1),vertices:v,indices:index,addresses:index,elements:original,overrides,base:elements,edited:elements.slice(),ids,ranges:[{firstIndex:0,count:indices.length,firstElement:0,copies:ids.length}],addressCount:0});
    if(a){a.vertexOffset+=vertexBytes;a.indexOffset+=indexBytes;a.elementOffset+=elementBytes;}
  }
  private async loadDetail(root:string,id:number,signal:AbortSignal){
    const d=this.levels(this.manifest.groups[Math.floor(id/2)])[id%2];
    let vb:ArrayBuffer,ib:ArrayBuffer;
    if(d.packet){
      const p=d.packet,response=await fetch(root+p.file,{signal});if(!response.ok)throw Error('Не удалось загрузить участок');
      const bytes=await response.arrayBuffer();signal.throwIfAborted();
      if(bytes.byteLength!==p.bytes||await sourceDigest([new Uint8Array(bytes)])!==p.sha256)throw Error('Повреждён пакет участка');
      ({vb,ib}=slicePack(bytes,{offset:0,vertexBytes:p.vertexBytes,indexBytes:p.bytes-p.vertexBytes}));
    }else{
      const responses=await Promise.all([fetch(root+d.vertices,{signal}),fetch(root+d.indices,{signal})]);
      if(responses.some(r=>!r.ok))throw new Error('Не удалось загрузить подробную геометрию');
      [vb,ib]=await Promise.all(responses.map(r=>r.arrayBuffer()));signal.throwIfAborted();
    }
    if(await sourceDigest([new Uint8Array(vb)])!==d.vertexDigest||await sourceDigest([new Uint8Array(ib)])!==d.indexDigest)throw new Error('Повреждена подробная геометрия');
    const vertices=new Uint8Array(d.vertexCount*20),indices=new Uint16Array(d.indexCount);
    MeshoptDecoder.decodeVertexBuffer(vertices,d.vertexCount,20,new Uint8Array(vb));MeshoptDecoder.decodeIndexBuffer(new Uint8Array(indices.buffer),d.indexCount,2,new Uint8Array(ib));
    if(indices.some(i=>i>=d.vertexCount))throw new Error('Invalid page index');
    const view=new DataView(vertices.buffer);for(let i=0;i<d.vertexCount;i++)if(!Number.isFinite(view.getFloat32(i*20+12,true))||!Number.isFinite(view.getFloat32(i*20+16,true)))throw new Error('Invalid page UV');
    signal.throwIfAborted();const created:GPUBuffer[]=[];
    try{
      const upload=(data:Uint8Array,usage:number)=>{const b=this.device.createBuffer({size:Math.ceil(data.byteLength/4)*4,usage:usage|GPUBufferUsage.COPY_DST});created.push(b);const padded=new Uint8Array(b.size);padded.set(data);this.device.queue.writeBuffer(b,0,padded);return b;};
      const v=upload(vertices,GPUBufferUsage.VERTEX),i=upload(new Uint8Array(indices.buffer),GPUBufferUsage.INDEX);
      await this.device.queue.onSubmittedWorkDone();signal.throwIfAborted();
      return {vertices:v,indices:i,count:d.indexCount,bytes:v.size+i.size,destroy(){v.destroy();i.destroy();}};
    }catch(e){for(const b of created)b.destroy();throw e;}
  }
  prepareDetail(eye:number[],target:number[],height:number,planes:Plane[]){
    if(!this.pageCache||this.streamingFrozen)return;
    const delta=target.map((v,a)=>v-eye[a]),length=Math.hypot(...delta),forward=delta.map(v=>v/length),requests:PageRequest[]=[];
    if(this.detailEnabled)for(const [id,g] of this.manifest.groups.entries()){
      const levels=this.levels(g);if(!levels.length)continue;
      let factor=0;for(const bounds of this.batches[id].bounds)if(intersectsFrustum(bounds,planes))factor=Math.max(factor,projectedError(bounds,eye,forward,height/(2*Math.tan(.65/2)),1));
      const selected=selectDetailLevel(levels.map(d=>d.errorWorld*factor),level=>this.pageCache!.has(id*2+level)||(level===0&&this.pageCache!.has(id*2+1)));
      if(selected>=0){const d=levels[selected];requests.push({id:id*2+selected,bytes:d.bytes,priority:levels[0].errorWorld*factor});}
    }
    this.pageCache.update(requests);
  }
  get activeTriangles(){return this.manifest.groups.reduce((n,g,id)=>n+(this.selectedPage(id)?.count??g.indexCount)/3*g.instances.length,0);}
  createBatchBind(layout:GPUBindGroupLayout){if(this.mobile)return;for(const b of this.batches)b.bind=this.device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:b.vertices}},{binding:1,resource:{buffer:b.overrides}}]});}
  get materialEdits(){return this.catalog.elements.filter(e=>e.material).length;}
  exportMaterials(){return exportMaterialPack(this.catalog,this.materialIdentity);}
  importMaterials(value:unknown){const n=importMaterialPack(value,this.catalog,this.materialIdentity);this.batching=true;this.updateMaterials();return n;}
  editMaterial(family:number,copy:number|null,color:number[],emission:number,roughness:number,metallic:number){const n=assignMaterial(this.catalog,family,copy,color,emission,roughness,metallic);this.batching=true;this.updateMaterials();return n;}
  resetMaterials(){clearMaterials(this.catalog);this.updateMaterials();}
  shadowVersion=0;private shadowOverrides='';
  private updateMaterials(){this.materialVersion++;const overrides=(this.catalog).elements.filter(e=>e.material!==0).map(e=>e.id).join(',');if(overrides!==this.shadowOverrides){this.shadowVersion++;this.shadowOverrides=overrides;}for(const b of this.batches){b.edited.set(b.base);for(const [i,id] of b.ids.entries()){const e=this.catalog.elements[id-1];if(!e.material)continue;const p=this.catalog.materials.subarray(e.material*8,e.material*8+8);b.edited.set(p.subarray(0,4),i*36+28);b.edited.set([p[4],p[5],p[6],1],i*36+32);b.edited[i*36+19]=0;}this.device.queue.writeBuffer(b.overrides,b.elementOffset??0,b.edited);}}
  cullingInfo={enabled:false,testedInstances:0,rejectedInstances:0};
  private visibilityPlanes:Plane[]|null|undefined;
  prepareVisibility(planes:Plane[]|null){
    // Geometry/transforms are immutable after loading. Reuse visibility when only materials change.
    if(planes===null&&this.visibilityPlanes===null)return;
    if(planes&&this.visibilityPlanes&&planes.every((p,i)=>p.every((v,j)=>v===this.visibilityPlanes![i][j])))return;
    let rejected=0,tested=0,changed=false;for(const b of this.batches)for(let i=0;i<b.ids.length;i++){const visible=!planes||intersectsFrustum(b.bounds[i],planes),v=visible?1:0;if(b.visibility[i]!==v)changed=true;b.visibility[i]=v;tested++;if(!visible)rejected++;}
    if(changed)this.visibilityVersion++;
    this.visibilityPlanes=planes?.map(p=>[...p] as Plane)??null;
    this.cullingInfo={enabled:!!planes,testedInstances:tested,rejectedInstances:rejected};
  }
  private visible(data:Float32Array,start:number,count:number,layer:Layer,visibility:Uint8Array){for(let i=start;i<start+count;i++)if((layer==='shadow'||visibility[i])&&((data[i*36+19]===1)===(layer==='glass')))return true;return false;}
  draw(pass:GPURenderPassEncoder|GPURenderBundleEncoder,mode:'A'|'B'|'C',layer:Layer){
    for(const [bi,b] of this.batches.entries()){
      if(mode==='B'&&this.batching&&!this.mobile){if(!this.visible(b.edited,0,b.ids.length,layer,b.visibility))continue;pass.setBindGroup(2,b.bind!);pass.setIndexBuffer(b.addresses,'uint32');pass.drawIndexed(b.addressCount);continue;}
      const edited=mode==='B'&&this.mobile;const data=edited?b.edited:b.base;
      const fine=layer==='shadow'?undefined:this.selectedPage(bi);
      pass.setVertexBuffer(0,fine?.vertices??b.vertices,fine?0:b.vertexOffset??0);pass.setVertexBuffer(1,edited?b.overrides:b.elements,b.elementOffset??0);pass.setIndexBuffer(fine?.indices??b.indices,this.mobile?'uint16':'uint32',fine?0:b.indexOffset??0);
      for(const range of b.ranges){const count=fine?.count??range.count;if(mode==='A'){for(let c=0;c<range.copies;c++)if(this.visible(data,range.firstElement+c,1,layer,b.visibility))pass.drawIndexed(count,1,range.firstIndex,0,range.firstElement+c);}
        else if(this.visible(data,range.firstElement,range.copies,layer,b.visibility))pass.drawIndexed(count,range.copies,range.firstIndex,0,range.firstElement);}
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
  get allocationBreakdown(){return this.batches.reduce((n,b)=>({commonVertices:n.commonVertices+(b.vertexBytes??b.vertices.size),ACIndices:n.ACIndices+(b.indexBytes??b.indices.size),BAddresses:n.BAddresses+(this.mobile?0:b.addresses.size),ACInstances:n.ACInstances+(b.elementBytes??b.elements.size),BInstances:n.BInstances+(b.elementBytes??b.overrides.size),streamedGeometry:n.streamedGeometry}),{commonVertices:0,ACIndices:0,BAddresses:0,ACInstances:0,BInstances:0,streamedGeometry:this.pageCache?.bytes??0});}
  get bytes(){return this.batches.reduce((n,b)=>n+(b.vertexBytes??b.vertices.size)+(b.indexBytes??b.indices.size)+(b.elementBytes??b.elements.size),0)+(this.pageCache?.bytes??0);}
  get structuredBytes(){return this.mobile?this.bytes:this.batching?this.batches.reduce((n,b)=>n+b.vertices.size+b.addresses.size+b.overrides.size,0):this.bytes;}
  get residentBytes(){return this.owned.reduce((n,b)=>n+b.size,0)+(this.pageCache?.bytes??0);}
  get cpuBytes(){return this.batches.reduce((n,b)=>n+b.base.byteLength+b.edited.byteLength,0)+this.catalog.instances.byteLength+this.catalog.materials.byteLength;}
  destroy(){this.pageCache?.destroy();for(const b of this.owned)b.destroy();this.owned=[];this.arena=undefined;this.batches.length=0;}
}
