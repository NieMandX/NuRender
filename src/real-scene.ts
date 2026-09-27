import {fetchAsset as fetch} from './asset-fetch';
import {assetUrl} from './asset-url';
import {withTextureCoordinates} from './texture-coordinates';
import {loadTextureManifest,loadCornerData,type TextureManifest} from './texture-assets';
import {exportMaterialPack,importMaterialPack} from './material-pack';
import {makeBatch,assignMaterial,clearMaterials,type BatchData} from './batch';
import {packGroup,sourceDigest,type PackedMesh} from './structured-real';
import {components,familyColor,type RepetitionReport} from './repetitions';
import {classifyVertices,type MaterialProvenance,type ClassifiedGroup} from './material-classification';
export type RealManifest={name:string;source:string;anchorObject:string;cropRule:string;materials:string;bounds:number[][];triangles:number;objects:{name:string;triangles:number}[];groups:{name:string;vertices:string;indices:string;vertexCount:number;indexCount:number;instances:number[][];objects:string[]}[]};
type MeshGPU={vertices:GPUBuffer;indices:GPUBuffer;instances:GPUBuffer;texcoords?:GPUBuffer;texStride?:number;count:number;indexCount:number};
const meshBytes=(g:MeshGPU)=>g.vertices.size+g.indices.size+g.instances.size+(g.texcoords?.size??0);
export class RealScene{
  groups:MeshGPU[]=[];
  analysis?:RepetitionReport;
  classification:ClassifiedGroup[]=[];
  structured:MeshGPU[]=[];
  private ownedStructured:{gpu:MeshGPU;cpu:PackedMesh;group:number}[]=[];
  textures!:TextureManifest;
  private sourceHash='';private layoutHash='';
  get materialIdentity(){return {sourceDigest:this.sourceHash,layoutDigest:this.layoutHash};}
  exportMaterials(){return exportMaterialPack(this.batchData!,this.materialIdentity);}
  importMaterials(value:unknown){const count=importMaterialPack(value,this.batchData!,this.materialIdentity);this.batching=true;this.uploadMaterials();return count;}
  preparationMs=0;
  batching=true;
  batchData?:BatchData;
  private batchGPU?:{vertices:GPUBuffer;indices:GPUBuffer;instances:GPUBuffer;materials:GPUBuffer;texcoords:GPUBuffer;texcoordOffsets:GPUBuffer};
  private batchBind?:GPUBindGroup;
  private repeated=new Set<MeshGPU>();
  get materialEdits(){return this.batchData?.elements.filter(e=>e.material!==0).length??0;}
  get batchBytes(){return this.batchGPU?Object.values(this.batchGPU).reduce((n,b)=>n+b.size,0):0;}
  get legacyBytes(){return this.structured.reduce((n,g)=>n+meshBytes(g),0);}
  get legacyDrawGroups(){return this.structured.reduce((n,g)=>n+(g.texStride?g.count:1),0);}
  get batchDrawGroups(){return this.structured.length-this.repeated.size+1;}
  createBatchBind(layout:GPUBindGroupLayout){const b=this.batchGPU!;this.batchBind=this.device.createBindGroup({layout,entries:[{binding:0,resource:{buffer:b.vertices}},{binding:1,resource:{buffer:b.instances}},{binding:2,resource:{buffer:b.materials}},{binding:3,resource:{buffer:b.texcoords}},{binding:4,resource:{buffer:b.texcoordOffsets}}]});}
  drawBatch(pass:GPURenderPassEncoder){pass.setBindGroup(2,this.batchBind!);pass.setIndexBuffer(this.batchGPU!.indices,'uint32');pass.drawIndexed(this.batchData!.indices.length);}
  editMaterial(family:number,copy:number|null,color:number[],emission:number,roughness=.7,metallic=0){const count=assignMaterial(this.batchData!,family,copy,color,emission,roughness,metallic);this.batching=true;this.uploadMaterials();return count;}
  resetMaterials(){clearMaterials(this.batchData!);this.uploadMaterials();}
  shadowVersion=0;private shadowOverrides='';
  private uploadMaterials(){const overrides=(this.batchData!).elements.filter(e=>e.material!==0).map(e=>e.id).join(',');if(overrides!==this.shadowOverrides){this.shadowVersion++;this.shadowOverrides=overrides;}this.device.queue.writeBuffer(this.batchGPU!.instances,0,this.batchData!.instances);this.device.queue.writeBuffer(this.batchGPU!.materials,0,this.batchData!.materials);}
  diagnostic=0; // 0: original; -1: all families; positive: family ID
  private cpuVertices:Float32Array<ArrayBuffer>[]=[];
  private labels:Uint32Array<ArrayBuffer>[]=[];
  constructor(readonly device:GPUDevice,readonly manifest:RealManifest){}
  static async load(device:GPUDevice){
    const root=assetUrl('scenes/m8-fragment/');
    const response=await fetch(root+'scene.json');if(!response.ok)throw new Error('Не удалось загрузить экспорт Blender');
    const manifestText=await response.text();
    const scene=new RealScene(device,JSON.parse(manifestText));
    const sourceChunks=[new TextEncoder().encode(manifestText)],cpuIndices:Uint32Array<ArrayBuffer>[]=[];
    const upload=(data:ArrayBuffer,usage:number,label:string)=>{
      const buffer=device.createBuffer({label,size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(buffer,0,data);return buffer;
    };
    try{
      // Sequential loading keeps the peak CPU working set bounded.
      for(const group of scene.manifest.groups){
        const [v,i]=await Promise.all([fetch(root+group.vertices),fetch(root+group.indices)]);
        if(!v.ok||!i.ok)throw new Error('Неполный экспорт Blender');
        const vb=await v.arrayBuffer(),ib=await i.arrayBuffer();
        if(vb.byteLength!==group.vertexCount*40||ib.byteLength!==group.indexCount*4)throw new Error('Размер mesh-буфера не совпадает с manifest');
        scene.cpuVertices.push(new Float32Array(vb));cpuIndices.push(new Uint32Array(ib));sourceChunks.push(new Uint8Array(vb),new Uint8Array(ib));
        scene.groups.push({vertices:upload(vb,GPUBufferUsage.VERTEX,group.name),indices:upload(ib,GPUBufferUsage.INDEX,group.name),instances:upload(new Float32Array(group.instances.flat()).buffer,GPUBufferUsage.VERTEX,'real object transforms'),count:group.instances.length,indexCount:group.indexCount});
      }
      scene.sourceHash=await sourceDigest(sourceChunks);
      await scene.loadAnalysis();
      await scene.classifySource(cpuIndices);
      const start=performance.now();
      for(const [i,group] of scene.manifest.groups.entries()){
        const families=scene.analysis!.families.filter(f=>f.group===i);
        if(!families.length){scene.structured.push(scene.groups[i]);continue;}
        if(group.instances.length!==1)throw new Error('Submesh templates require a single source object');
        for(const cpu of packGroup(scene.cpuVertices[i],cpuIndices[i],group.instances[0],families)){
          const gpu={vertices:upload(cpu.vertices.buffer,GPUBufferUsage.VERTEX,'B template or residual'),indices:upload(cpu.indices.buffer,GPUBufferUsage.INDEX,'B indices'),instances:upload(cpu.instances.buffer,GPUBufferUsage.VERTEX,'B repeated component transforms'),count:cpu.instances.length/28,indexCount:cpu.indices.length};
          if(cpu.family)scene.repeated.add(gpu);scene.ownedStructured.push({gpu,cpu,group:i});scene.structured.push(gpu);
        }
      }
      scene.batchData=makeBatch(scene.ownedStructured.map(g=>g.cpu));
      let b=scene.batchData;
      // Automatic defaults are independent of user overrides saved in 0.7 packs.
      const identityVertices=b.vertices.slice();for(let i=9;i<identityVertices.length;i+=10)identityVertices[i]=0;
      scene.layoutHash=await sourceDigest([new Uint8Array(identityVertices.buffer),new Uint8Array(b.indices.buffer),new Uint8Array(b.instances.buffer)]);
      scene.textures=await loadTextureManifest(scene.sourceHash);
      if(scene.textures.groups.length!==scene.groups.length)throw new Error('Неверное число UV-групп');
      for(const [i,group] of scene.manifest.groups.entries()){
        const corners=await loadCornerData(scene.textures,i,group.name,group.indexCount);
        const families=scene.analysis!.families.filter(f=>f.group===i);
        const parts=families.length?new Map(components(scene.cpuVertices[i],cpuIndices[i],group.instances[0]).map(c=>[c.triangles[0],c])):undefined;
        for(const owned of scene.ownedStructured.filter(x=>x.group===i)){
          owned.cpu=withTextureCoordinates(owned.cpu,corners,families.find(f=>f.id===owned.cpu.family),parts);
          const {gpu,cpu}=owned;gpu.vertices.destroy();gpu.indices.destroy();
          gpu.vertices=upload(cpu.vertices.buffer,GPUBufferUsage.VERTEX,'B textured vertices');gpu.indices=upload(cpu.indices.buffer,GPUBufferUsage.INDEX,'B textured indices');
          gpu.texcoords=upload(cpu.textureCopies!.buffer,GPUBufferUsage.VERTEX,'B per-copy UV coordinates');const stride=cpu.vertices.length/10*4;
          const distinct=cpu.family&&cpu.textureCopies!.some((value,k)=>value!==cpu.textureCopies![k%stride]);
          gpu.texStride=distinct?stride*4:0;
        }
        const source=withTextureCoordinates({vertices:scene.cpuVertices[i],indices:cpuIndices[i],instances:new Float32Array(),labels:scene.labels[i],family:0,sourceTriangles:Array.from({length:group.indexCount/3},(_,t)=>t)},corners);
        const gpu=scene.groups[i];gpu.vertices.destroy();gpu.indices.destroy();
        gpu.vertices=upload(source.vertices.buffer,GPUBufferUsage.VERTEX,'A/C textured vertices');gpu.indices=upload(source.indices.buffer,GPUBufferUsage.INDEX,'A/C textured indices');gpu.texcoords=upload(source.textureCopies!.buffer,GPUBufferUsage.VERTEX,'A/C UV coordinates');
        scene.cpuVertices[i]=source.vertices;scene.labels[i]=source.labels;
      }
      b=scene.batchData=makeBatch(scene.ownedStructured.map(g=>g.cpu));
      scene.batchGPU={vertices:upload(b.vertices.buffer,GPUBufferUsage.STORAGE,'B batch vertices'),indices:upload(b.indices.buffer,GPUBufferUsage.INDEX,'B batch addresses'),instances:upload(b.instances.buffer,GPUBufferUsage.STORAGE,'B element IDs and transforms'),materials:upload(b.materials.buffer,GPUBufferUsage.STORAGE,'B material table'),texcoords:upload(b.texcoords.buffer,GPUBufferUsage.STORAGE,'B per-copy texture coordinates'),texcoordOffsets:upload(b.texcoordOffsets.buffer,GPUBufferUsage.STORAGE,'B texture address offsets')};
      scene.preparationMs=performance.now()-start;
      if(scene.structured.reduce((n,g)=>n+g.indexCount*g.count/3,0)!==scene.manifest.triangles)throw new Error('Structured triangle count mismatch');
      return scene;
    }catch(e){scene.destroy();throw e;}
  }
  private async classifySource(indices:Uint32Array[]){
    const root=assetUrl('scenes/m8-fragment/'),response=await fetch(root+'materials.json');
    let provenance:MaterialProvenance|undefined;
    if(response.ok){provenance=await response.json();if(provenance!.version!==1||provenance!.sourceDigest!==this.sourceHash||provenance!.groups.length!==this.groups.length)throw new Error('Имена материалов не соответствуют исходному экспорту');}
    else if(response.status!==404)throw new Error('Не удалось загрузить имена материалов');
    for(const [i,g] of this.manifest.groups.entries()){
      const meta=provenance?.groups[i];let slots=new Uint32Array(g.vertexCount),names=[''];
      if(meta){
        if(meta.name!==g.name||meta.vertexCount!==g.vertexCount||!meta.materialNames.every(n=>typeof n==='string')||!/^group-\d+\.material-slots\.bin$/.test(meta.vertexSlots))throw new Error('Неверная карта исходных материалов');
        const r=await fetch(root+meta.vertexSlots);if(!r.ok)throw new Error('Нет карты исходных материалов');
        const bytes=await r.arrayBuffer();if(bytes.byteLength!==g.vertexCount*4)throw new Error('Размер карты материалов не совпадает');
        slots=new Uint32Array(bytes);names=meta.materialNames;
      }
      const materials=classifyVertices(this.cpuVertices[i],indices[i],slots,names,[...g.objects,g.name]);
      this.classification.push({group:i,name:g.objects.join(', '),materials});
      this.device.queue.writeBuffer(this.groups[i].vertices,0,this.cpuVertices[i]);
    }
  }
  async loadAnalysis(){
    if(this.analysis)return this.analysis;
    const root=assetUrl('scenes/m8-fragment/');
    const response=await fetch(root+'repetitions.json');if(!response.ok)throw new Error('Нет результатов разбора. Запустите npm run analyse.');
    const report:RepetitionReport=await response.json();
    if(report.sourceDigest!==this.sourceHash)throw new Error('Устаревший разбор: исходная геометрия изменилась. Запустите npm run analyse.');
    if(report.groups.length!==this.groups.length)throw new Error('Разбор не соответствует сцене');
    const labels:Uint32Array<ArrayBuffer>[]=[];
    for(const [i,g] of report.groups.entries()){
      const r=await fetch(root+g.labels);if(!r.ok)throw new Error('Нет карты повторений');const data=await r.arrayBuffer();
      if(data.byteLength!==this.cpuVertices[i].length/10*4)throw new Error('Размер карты повторений не совпадает');
      labels.push(new Uint32Array(data));
    }
    this.labels=labels;this.analysis=report;return report;
  }
  setDiagnostic(id:number){
    if(id!==0&&!this.analysis)throw new Error('Сначала загрузите разбор');
    if(id>0&&!this.analysis!.families.some(f=>f.id===id))throw new Error('Неизвестная группа');
    for(const [i,g] of this.groups.entries()){
      const original=this.cpuVertices[i],data=id===0?original:original.slice();
      if(id!==0)for(let v=0;v<data.length/10;v++){
        const family=this.labels[i][v],selected=family>0&&(id===-1||id===family);
        const color=familyColor(selected?family:0);data.set(color,v*10+6);
      }
      this.device.queue.writeBuffer(g.vertices,0,data);
    }
    for(const {gpu,cpu} of this.ownedStructured){
      const data=id===0?cpu.vertices:cpu.vertices.slice();
      if(id!==0)for(let v=0;v<data.length/10;v++){const f=cpu.labels[v];data.set(familyColor(f>0&&(id===-1||id===f)?f:0),v*10+6);}
      this.device.queue.writeBuffer(gpu.vertices,0,data);
    }
    if(this.batchData&&this.batchGPU){const b=this.batchData,data=id===0?b.vertices:b.vertices.slice();if(id!==0)for(let v=0;v<data.length/10;v++){const f=b.labels[v];data.set(familyColor(f>0&&(id===-1||id===f)?f:0),v*10+6);}this.device.queue.writeBuffer(this.batchGPU.vertices,0,data);}
    this.diagnostic=id;
  }
  get cpuBytes(){return (this.batchData?[this.batchData.vertices,this.batchData.labels,this.batchData.instances,this.batchData.indices,this.batchData.materials,this.batchData.texcoords,this.batchData.texcoordOffsets].reduce((n,b)=>n+b.byteLength,0):0)+this.ownedStructured.reduce((n,g)=>n+g.cpu.vertices.byteLength+g.cpu.indices.byteLength+g.cpu.instances.byteLength+g.cpu.labels.byteLength+(g.cpu.textureCopies?.byteLength??0),0)+this.cpuVertices.reduce((n,v)=>n+v.byteLength,0)+this.labels.reduce((n,l)=>n+l.byteLength,0);}
  get bytes(){return this.groups.reduce((n,g)=>n+meshBytes(g),0);}
  get structuredBytes(){if(this.batching)return this.batchBytes+this.structured.filter(g=>!this.repeated.has(g)).reduce((n,g)=>n+meshBytes(g),0);return this.structured.reduce((n,g)=>n+meshBytes(g),0);}
  get extraBytes(){return this.ownedStructured.reduce((n,{gpu:g})=>n+meshBytes(g),0);}
  get residentBytes(){return this.bytes+this.extraBytes+this.batchBytes;}
  get structuredInstances(){return this.structured.reduce((n,g)=>n+g.count,0);}
  draw(pass:GPURenderPassEncoder,mode:'A'|'B'|'C'){
    for(const g of mode==='B'?this.structured:this.groups){
      if(mode==='B'&&this.batching&&this.repeated.has(g))continue;
      pass.setVertexBuffer(0,g.vertices);pass.setVertexBuffer(1,g.instances);pass.setIndexBuffer(g.indices,'uint32');
      if(g.texStride){for(let i=0;i<g.count;i++){pass.setVertexBuffer(2,g.texcoords!,i*g.texStride,g.texStride);pass.drawIndexed(g.indexCount,1,0,0,i);}}
      else {pass.setVertexBuffer(2,g.texcoords!);if(mode!=='A')pass.drawIndexed(g.indexCount,g.count);else for(let i=0;i<g.count;i++)pass.drawIndexed(g.indexCount,1,0,0,i);}
    }
  }
  destroy(){if(this.batchGPU)for(const b of Object.values(this.batchGPU))b.destroy();this.batchGPU=undefined;this.batchData=undefined;this.batchBind=undefined;this.repeated.clear();for(const {gpu:g} of this.ownedStructured){g.vertices.destroy();g.indices.destroy();g.instances.destroy();g.texcoords?.destroy();}this.ownedStructured=[];this.structured=[];for(const g of this.groups){g.vertices.destroy();g.indices.destroy();g.instances.destroy();g.texcoords?.destroy();}this.groups=[];this.cpuVertices=[];this.labels=[];this.analysis=undefined;}
}
