import {frustumPlanes} from './frustum';
import {chooseProfile,renderSize} from './device-profile';
import {PrefilteredIBL} from './prefiltered-ibl';
import {FullScene,FULL_ROOT,MOBILE_ROOT} from './full-scene';
import {HDREnvironment,HDR_SOURCE} from './hdr-environment';
import {TextureAssets} from './texture-assets';
import { mat4 } from 'wgpu-matrix';
import shader from './shader.wgsl?raw';
import transparencyShader from './transparency.wgsl?raw';
import { sceneGroups, commonParts, concat, mergedMesh, expand, packTemplate, packBuildings, cube, MODES, type Detail, type Mode } from './scene';
import {decodePassTimestamps,type Sample,type PassName} from './stats';
import { RealScene } from './real-scene';
type GroupGPU={parts:GPUBuffer; buildings:GPUBuffer; mesh:GPUBuffer; indices:GPUBuffer; bind:GPUBindGroup; count:number; partCount:number; indexCount:number};
export class Renderer {
  source: 'procedural'|'blender'|'full' = 'procedural';
  private full?:FullScene;private fullTextures?:TextureAssets;
  private fullBatchLayout!:GPUBindGroupLayout;private fullPipelines!:GPURenderPipeline[];private fullBatchPipelines!:GPURenderPipeline[];
  private get activeReal(){return this.source==='full'?this.full:this.real;}
  private real?:RealScene; private realPipeline!:GPURenderPipeline; private realShadow!:GPURenderPipeline;
  private batchLayout!:GPUBindGroupLayout;private batchPipeline!:GPURenderPipeline;private batchShadow!:GPURenderPipeline;
  private realTransparent!:GPURenderPipeline;private batchTransparent!:GPURenderPipeline;
  private compositePipeline!:GPURenderPipeline;private compositeLayout!:GPUBindGroupLayout;private compositeBind?:GPUBindGroup;
  private accumulation?:GPUTexture;private revealage?:GPUTexture;
  culling=true;textureMode=2;environmentMode=1;environmentRotation=0;iblMode=1;
  private prefiltered!:PrefilteredIBL;
  private environment!:HDREnvironment;
  private textureLayout!:GPUBindGroupLayout;private fallbackTextures!:TextureAssets;private realTextures?:TextureAssets;
  mode: Mode = 'A'; detail: Detail = 'full'; count = 64; types = 4;
  yaw = .72; pitch = .68; distance = 245;
  device!: GPUDevice; context!: GPUCanvasContext; adapterInfo: unknown;
  hasTimestamps = false; stopped = false;
  renderedFrames = 0;
  private shadowKey='';private sceneRevision=0;private shadowBuilds=0;private shadowReuses=0;private lastShadowRebuilt=false;
  private format!: GPUTextureFormat;
  private uniform!: GPUBuffer; private vertex!: GPUBuffer; private index!: GPUBuffer;
  private a!: GPUBuffer; private g!: GPUBuffer; private dummy!: GPUBuffer;
  private groups:GroupGPU[]=[]; private totalParts=0; private buildMs=0;
  private bindA!: GPUBindGroup; private bindG!: GPUBindGroup;
  private layout!: GPUBindGroupLayout; private lightBind!: GPUBindGroup;
  private pipelines!: Record<Mode,GPURenderPipeline>; private shadows!: Record<Mode,GPURenderPipeline>;
  private depth?: GPUTexture; private shadow!: GPUTexture;
  private queries?: GPUQuerySet; private resolve?: GPUBuffer; private readback?: GPUBuffer;
  private partCount = 0; private groundCount = 0;
  private size = [0,0]; private timestampBusy = false;
  onError: (message:string)=>void = ()=>{};
  readonly profile=chooseProfile(new URL(location.href).searchParams.get('profile')??import.meta.env?.VITE_DEFAULT_PROFILE??null,navigator.maxTouchPoints,navigator.userAgent,matchMedia('(pointer:coarse)').matches);
  get mobile(){return this.profile==='mobile';}
  constructor(readonly canvas:HTMLCanvasElement) {if(this.mobile){this.count=16;this.mode='B';}}
  async init() {
    if (!navigator.gpu) throw new Error(!isSecureContext?'WebGPU требует HTTPS. На телефоне откройте защищённый адрес сайта.':'WebGPU недоступен. Нужен браузер с поддержкой WebGPU (например, Safari 26 или совместимый Chrome).');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('Браузер не предоставил GPU-адаптер WebGPU.');
    this.hasTimestamps = adapter.features.has('timestamp-query');
    this.adapterInfo = {vendor:adapter.info.vendor,architecture:adapter.info.architecture,device:adapter.info.device,description:adapter.info.description};
    this.device = await adapter.requestDevice({requiredFeatures:this.hasTimestamps?['timestamp-query']:[]});
    this.device.lost.then(info=>{ this.stopped=true; this.onError(`GPU device lost: ${info.message || info.reason}. Перезагрузите страницу.`); });
    this.device.addEventListener('uncapturederror',event=>{this.stopped=true;this.onError(event.error.message);});
    this.context = this.canvas.getContext('webgpu')!;
    if (!this.context) throw new Error('Не удалось создать WebGPU canvas.');
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({device:this.device,format:this.format,alphaMode:'opaque',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
    const mesh=cube();
    this.vertex=this.buffer(mesh.vertices,GPUBufferUsage.VERTEX,'shared cube vertices');
    this.index=this.buffer(mesh.indices,GPUBufferUsage.INDEX,'shared cube indices');
    this.uniform=this.device.createBuffer({size:176,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,label:'camera and scene uniforms'});
    this.layout=this.device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},
      {binding:1,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},
      {binding:2,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage'}},
    ]});
    const lightLayout=this.device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'depth'}},
      {binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'comparison'}},
      {binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{}},
      {binding:3,visibility:GPUShaderStage.FRAGMENT,sampler:{}},
      {binding:4,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},
      {binding:5,visibility:GPUShaderStage.FRAGMENT,texture:{viewDimension:'cube'}},
      {binding:6,visibility:GPUShaderStage.FRAGMENT,texture:{}},
      {binding:7,visibility:GPUShaderStage.FRAGMENT,sampler:{}},
    ]});
    this.shadow=this.device.createTexture({size:this.mobile?[1024,1024]:[2048,2048],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
    this.environment=await HDREnvironment.create(this.device);this.prefiltered=await PrefilteredIBL.create(this.device);
    this.lightBind=this.device.createBindGroup({layout:lightLayout,entries:[{binding:0,resource:this.shadow.createView()},{binding:1,resource:this.device.createSampler({compare:'less-equal',magFilter:'linear',minFilter:'linear'})},{binding:2,resource:this.environment.texture.createView()},{binding:3,resource:this.environment.sampler},{binding:4,resource:{buffer:this.environment.sh}},{binding:5,resource:this.prefiltered.texture.createView({dimension:'cube'})},{binding:6,resource:this.prefiltered.lut.createView()},{binding:7,resource:this.prefiltered.sampler}]});
    const module=this.device.createShaderModule({code:shader});
    const errors=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');
    if(errors.length) throw new Error(errors.map(m=>`${m.lineNum}: ${m.message}`).join('\n'));
    const buffers: GPUVertexBufferLayout[]=[{arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'}]}];
    this.textureLayout=TextureAssets.layout(this.device);this.fallbackTextures=await TextureAssets.create(this.device,this.textureLayout);
    const emptyLayout=this.device.createBindGroupLayout({entries:[]});
    const pipelineLayout=this.device.createPipelineLayout({bindGroupLayouts:[this.layout,lightLayout,emptyLayout,this.textureLayout]});
    const shadowLayout=this.device.createPipelineLayout({bindGroupLayouts:[this.layout]});
    this.pipelines={} as Record<Mode,GPURenderPipeline>;this.shadows={} as Record<Mode,GPURenderPipeline>;
    this.device.pushErrorScope('validation');
    const meshBuffers: GPUVertexBufferLayout[]=[
      {arrayStride:40,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x4'}]},
      {arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:3,offset:0,format:'float32x4'},{shaderLocation:4,offset:16,format:'float32x4'}]},
    ];
    for(const mode of MODES) {
      const constants={STRUCTURED:mode==='B'?1:0};
      this.pipelines[mode]=await this.device.createRenderPipelineAsync({layout:pipelineLayout,vertex:{module,entryPoint:mode==='C'?'vsMerged':'vs',buffers:mode==='C'?meshBuffers:buffers,constants},fragment:{module,entryPoint:'fs',targets:[{format:this.format}]},primitive:{cullMode:'back'},depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less'}});
      this.shadows[mode]=await this.device.createRenderPipelineAsync({layout:shadowLayout,vertex:{module,entryPoint:mode==='C'?'shadowMerged':'shadowVS',buffers:mode==='C'?meshBuffers:buffers,constants},primitive:{cullMode:'back'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less',depthBias:2,depthBiasSlopeScale:2}});
    }
    const realBuffers:GPUVertexBufferLayout[]=[meshBuffers[0],{arrayStride:112,stepMode:'instance',attributes:Array.from({length:7},(_,i)=>({shaderLocation:i+3,offset:i*16,format:'float32x4' as const}))},{arrayStride:16,attributes:[{shaderLocation:10,offset:0,format:'float32x4'}]}];
    this.realPipeline=await this.device.createRenderPipelineAsync({layout:pipelineLayout,vertex:{module,entryPoint:'vsReal',buffers:realBuffers},fragment:{module,entryPoint:'fs',targets:[{format:this.format}]},primitive:{cullMode:'none'},depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less'}});
    this.realShadow=await this.device.createRenderPipelineAsync({layout:shadowLayout,vertex:{module,entryPoint:'shadowReal',buffers:realBuffers},fragment:{module,entryPoint:'shadowMask',targets:[]},primitive:{cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less',depthBias:2,depthBiasSlopeScale:2}});
    this.batchLayout=this.device.createBindGroupLayout({entries:[0,1,2,3,4].map(binding=>({binding,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage' as const}}))});
    this.batchPipeline=await this.device.createRenderPipelineAsync({layout:this.device.createPipelineLayout({bindGroupLayouts:[this.layout,lightLayout,this.batchLayout,this.textureLayout]}),vertex:{module,entryPoint:'vsBatch'},fragment:{module,entryPoint:'fs',targets:[{format:this.format}]},primitive:{cullMode:'none'},depthStencil:{format:'depth24plus',depthWriteEnabled:true,depthCompare:'less'}});
    this.batchShadow=await this.device.createRenderPipelineAsync({layout:this.device.createPipelineLayout({bindGroupLayouts:[this.layout,this.device.createBindGroupLayout({entries:[]}),this.batchLayout]}),vertex:{module,entryPoint:'shadowBatch'},fragment:{module,entryPoint:'shadowMask',targets:[]},primitive:{cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less',depthBias:2,depthBiasSlopeScale:2}});
    const targets:GPUColorTargetState[]=[
      {format:'rgba16float',blend:{color:{srcFactor:'one',dstFactor:'one'},alpha:{srcFactor:'one',dstFactor:'one'}}},
      {format:'r8unorm',blend:{color:{srcFactor:'zero',dstFactor:'one-minus-src'},alpha:{srcFactor:'zero',dstFactor:'one'}}},
    ];
    this.realTransparent=await this.device.createRenderPipelineAsync({layout:pipelineLayout,vertex:{module,entryPoint:'vsReal',buffers:realBuffers},fragment:{module,entryPoint:'fsTransparent',targets},primitive:{cullMode:'none'},depthStencil:{format:'depth24plus',depthWriteEnabled:false,depthCompare:'less'}});
    this.batchTransparent=await this.device.createRenderPipelineAsync({layout:this.device.createPipelineLayout({bindGroupLayouts:[this.layout,lightLayout,this.batchLayout,this.textureLayout]}),vertex:{module,entryPoint:'vsBatch'},fragment:{module,entryPoint:'fsTransparent',targets},primitive:{cullMode:'none'},depthStencil:{format:'depth24plus',depthWriteEnabled:false,depthCompare:'less'}});
    this.fullBatchLayout=this.device.createBindGroupLayout({entries:[0,1].map(binding=>({binding,visibility:GPUShaderStage.VERTEX,buffer:{type:'read-only-storage' as const}}))});
    const fullBuffers:GPUVertexBufferLayout[]=[{arrayStride:32,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x2'}]},{arrayStride:144,stepMode:'instance',attributes:Array.from({length:9},(_,i)=>({shaderLocation:i+3,offset:i*16,format:'float32x4' as const}))}];
    if(this.mobile)fullBuffers[0]={arrayStride:20,attributes:[{shaderLocation:0,offset:0,format:'unorm16x4'},{shaderLocation:1,offset:8,format:'snorm8x4'},{shaderLocation:2,offset:12,format:'float32x2'}]};
    this.fullPipelines=[];this.fullBatchPipelines=[];
    for(const batched of [false,true])for(let layer=0;layer<3;layer++){
      const isShadow=layer===0,layout=isShadow?this.device.createPipelineLayout({bindGroupLayouts:batched?[this.layout,emptyLayout,this.fullBatchLayout]:[this.layout]}):this.device.createPipelineLayout({bindGroupLayouts:[this.layout,lightLayout,batched?this.fullBatchLayout:emptyLayout,this.textureLayout]});
      const pipeline=await this.device.createRenderPipelineAsync({layout,vertex:{module,entryPoint:isShadow?(batched?'shadowFullBatch':this.mobile?'shadowMobile':'shadowFull'):(batched?'vsFullBatch':this.mobile?'vsMobile':'vsFull'),buffers:batched?[]:fullBuffers},fragment:{module,entryPoint:isShadow?'shadowMask':layer===2?'fsTransparent':'fs',targets:isShadow?[]:layer===2?targets:[{format:this.format}]},primitive:{cullMode:'none'},depthStencil:{format:isShadow?'depth32float':'depth24plus',depthWriteEnabled:layer!==2,depthCompare:'less',...(isShadow?{depthBias:2,depthBiasSlopeScale:2}:{})}});
      (batched?this.fullBatchPipelines:this.fullPipelines).push(pipeline);
    }
    this.compositeLayout=this.device.createBindGroupLayout({entries:[0,1].map(binding=>({binding,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'unfilterable-float' as const}}))});
    const composite=this.device.createShaderModule({code:transparencyShader});
    this.compositePipeline=await this.device.createRenderPipelineAsync({layout:this.device.createPipelineLayout({bindGroupLayouts:[this.compositeLayout]}),vertex:{module:composite,entryPoint:'vs'},fragment:{module:composite,entryPoint:'fs',targets:[{format:this.format,blend:{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}}]}});
    const err=await this.device.popErrorScope();if(err)throw new Error(err.message);
    if(this.hasTimestamps) {
      this.queries=this.device.createQuerySet({type:'timestamp',count:8});
      this.resolve=this.device.createBuffer({size:64,usage:GPUBufferUsage.QUERY_RESOLVE|GPUBufferUsage.COPY_SRC});
      this.readback=this.device.createBuffer({size:64,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    }
    this.rebuild();
  }
  private buffer(data:Float32Array<ArrayBuffer>|Uint16Array<ArrayBuffer>|Uint32Array<ArrayBuffer>, usage:GPUBufferUsageFlags,label:string) {
    const buffer=this.device.createBuffer({label,size:data.byteLength,usage:usage|GPUBufferUsage.COPY_DST});
    this.device.queue.writeBuffer(buffer,0,data);return buffer;
  }
  rebuild() {
    this.sceneRevision++;
    const start=performance.now();
    this.a?.destroy();this.g?.destroy();this.dummy?.destroy();
    for(const g of this.groups){g.parts.destroy();g.buildings.destroy();g.mesh.destroy();g.indices.destroy();}
    const groups=sceneGroups(this.count,this.detail,this.types);
    this.totalParts=groups.reduce((n,g)=>n+g.parts.length*g.items.length,0);
    this.partCount=groups[0].parts.length;
    this.a=this.buffer(concat(groups.map(g=>expand(g.parts,g.items))),GPUBufferUsage.STORAGE,'A expanded instances');
    this.dummy=this.buffer(new Float32Array(8),GPUBufferUsage.STORAGE,'unused binding placeholder');
    const common=commonParts(this.count,this.detail,this.types);this.groundCount=common.length/12;
    this.g=this.buffer(common,GPUBufferUsage.STORAGE,'shared ground and unique residual details');
    const bind=(parts:GPUBuffer,buildings:GPUBuffer)=>this.device.createBindGroup({layout:this.layout,entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:parts}},{binding:2,resource:{buffer:buildings}}]});
    this.bindA=bind(this.a,this.dummy);this.bindG=bind(this.g,this.dummy);
    this.groups=groups.map(g=>{
      const parts=this.buffer(packTemplate(g.parts),GPUBufferUsage.STORAGE,'B template');
      const instances=this.buffer(packBuildings(g.items),GPUBufferUsage.STORAGE|GPUBufferUsage.VERTEX,'shared B/C building instances');
      const mesh=mergedMesh(g.parts);
      return {parts,buildings:instances,mesh:this.buffer(mesh.vertices,GPUBufferUsage.VERTEX,'C baked building vertices'),indices:this.buffer(mesh.indices,GPUBufferUsage.INDEX,'C baked building indices'),bind:bind(parts,instances),count:g.items.length,partCount:g.parts.length,indexCount:mesh.indices.length};
    });
    this.buildMs=performance.now()-start;
  }
  async setSource(source:'procedural'|'blender'|'full',progress:(s:string)=>void=()=>{}){
    if(this.mobile&&source!==this.source){
      this.real?.destroy();this.real=undefined;this.realTextures?.destroy();this.realTextures=undefined;
      this.full?.destroy();this.full=undefined;this.fullTextures?.destroy();this.fullTextures=undefined;
      this.source='procedural';this.resetCamera();await this.device.queue.onSubmittedWorkDone();
    }
    if(source==='full'&&!this.full){
      const scene=await FullScene.load(this.device,progress,this.mobile);
      try{const textures=await TextureAssets.create(this.device,this.textureLayout,scene.textures,this.mobile?MOBILE_ROOT:FULL_ROOT,this.mobile?256:512,progress);scene.createBatchBind(this.fullBatchLayout);this.full=scene;this.fullTextures=textures;}catch(e){scene.destroy();throw e;}
    }
    if(source==='blender'&&!this.real){
      const scene=await RealScene.load(this.device);
      try{const textures=await TextureAssets.create(this.device,this.textureLayout,scene.textures,undefined,this.mobile?256:1024,progress);scene.createBatchBind(this.batchLayout);this.real=scene;this.realTextures=textures;}catch(error){scene.destroy();throw error;}
    }
    this.source=source;this.resetCamera();
  }
  get environmentInfo(){return {...HDR_SOURCE,bytes:this.environment?.bytes??0,mode:this.environmentMode,rotation:this.environmentRotation,specular:this.iblMode?'prefiltered GGX + BRDF LUT':'16 GGX samples',prefilteredBytes:this.prefiltered?.bytes??0};}
  get textureInfo(){const scene=this.activeReal;return scene?{images:scene.textures.images.length,materials:scene.textures.materials.length,mappedMaterials:scene.textures.materials.filter(m=>Object.keys(m.maps).length).length,bytes:(this.source==='full'?this.fullTextures:this.realTextures)?.bytes??0,resolution:this.mobile?256:this.source==='full'?512:1024,warnings:scene.textures.warnings}:undefined;}
  get batching(){return this.activeReal?.batching??true;}
  set batching(value:boolean){if(this.activeReal){if(this.activeReal.materialEdits&&!value)throw new Error('Reset materials first');this.activeReal.batching=value;}}
  get materialEdits(){return this.source!=='procedural'?(this.activeReal?.materialEdits??0):0;}
  get classification(){return this.source!=='procedural'?this.activeReal?.classification:undefined;}
  get hasTransparency(){return this.source!=='procedural'&&this.diagnostic===0&&!!this.activeReal?.classification.some(g=>g.materials.some(m=>m.triangles>0&&m.classification.kind==='glass'));}
  editMaterial(family:number,copy:number|null,color:number[],emission:number,roughness=.7,metallic=0){this.mode='B';this.setDiagnostic(0);return this.activeReal!.editMaterial(family,copy,color,emission,roughness,metallic);}
  get materialIdentity(){return this.activeReal?.materialIdentity;}
  exportMaterials(){return this.activeReal!.exportMaterials();}
  importMaterials(value:unknown){const n=this.activeReal!.importMaterials(value);this.mode='B';this.setDiagnostic(0);return n;}
  resetMaterials(){this.activeReal?.resetMaterials();}
  get analysis(){return this.source==='blender'?this.real?.analysis:undefined;}
  get materialFamilies(){return this.source==='full'?this.full?.manifest.families:this.real?.analysis?.families;}
  get diagnostic(){return this.source==='blender'?(this.real?.diagnostic??0):0;}
  async loadAnalysis(){if(!this.real)throw new Error('Загрузите Blender');return this.real.loadAnalysis();}
  setDiagnostic(id:number){if(this.source==='blender')this.real?.setDiagnostic(id);}
  private focusBounds:number[][]|null=null;
  focusFamily(id:number){const f=this.materialFamilies?.find(f=>f.id===id);if(!f)return;this.focusBounds=f.bounds;this.yaw=Math.PI;this.pitch=.24;this.distance=Math.max(25,this.framing.radius*3);}
  get activeModes():Mode[]{return MODES;}
  get sourceInfo(){return this.source!=='procedural'?this.activeReal?.manifest:null;}
  private get framing(){
    if(this.source!=='procedural'&&this.activeReal){const [lo,hi]=this.focusBounds??this.activeReal.manifest.bounds;return {target:lo.map((x,i)=>(x+hi[i])/2),radius:Math.max(hi[0]-lo[0],hi[2]-lo[2],hi[1]-lo[1])*.75};}
    return {target:[0,9,0],radius:Math.ceil(Math.sqrt(this.count))*16+25};
  }
  get cameraFraming(){return this.framing;}
  resetCamera(){this.focusBounds=null;this.yaw=.72;this.pitch=.68;this.distance=this.source!=='procedural'?this.framing.radius*3:Math.sqrt(this.count)*42;}
  get shadowCacheInfo(){return {policy:'static',builds:this.shadowBuilds,reuses:this.shadowReuses,lastFrameRebuilt:this.lastShadowRebuilt};}
  get metrics() {
    const shared=this.vertex.size+this.index.size+this.g.size+this.dummy.size;
    const templates=this.groups.reduce((n,g)=>n+g.parts.size,0);
    const transforms=this.groups.reduce((n,g)=>n+g.buildings.size,0);
    const mergedGeometry=this.groups.reduce((n,g)=>n+g.mesh.size+g.indices.size,0);
    const coldDraws={A:4,B:2*(1+this.groups.length),C:2*(1+this.groups.length)};
    const draws={A:2,B:1+this.groups.length,C:1+this.groups.length};
    const instances={A:this.totalParts+this.groundCount,B:this.totalParts+this.groundCount,C:this.count+this.groundCount};
    const procedural={instances:instances[this.mode],instancesByMode:instances,logicalParts:this.totalParts+this.groundCount,triangles:(this.totalParts+this.groundCount)*12,templateCount:this.groups.length,uniqueResidualParts:this.groundCount-this.count-1,
      bytesA:shared+this.a.size,bytesB:shared+templates+transforms,bytesC:shared+mergedGeometry+transforms,
      residentSceneBuffers:shared+this.a.size+templates+transforms+mergedGeometry,
      allocationBreakdown:{common:shared,AInstances:this.a.size,BTemplates:templates,BCTransforms:transforms,CMergedGeometry:mergedGeometry},
      rebuildCpuMs:this.buildMs,commonGeometryBytes:shared,uniformBytes:176,materialTextureBytes:this.realTextures?.bytes??0,environmentTextureBytes:this.environment.bytes+this.prefiltered.bytes,textureMode:this.textureMode,shadowTextureBytes:(this.mobile?1024:2048)**2*4,profile:this.profile,
      transparencyTextureBytes:this.accumulation?this.canvas.width*this.canvas.height*9:0,drawCalls:draws[this.mode],drawCallsByMode:draws,coldDrawCallsByMode:coldDraws,shadowCache:this.shadowCacheInfo,width:this.canvas.width,height:this.canvas.height,renderedFrames:this.renderedFrames};
    if(this.source==='full'&&this.full){
      const scene=this.full,objects=scene.manifest.objects.length,draws={A:scene.drawCount('A',false),B:scene.drawCount('B',false),C:scene.drawCount('C',false)},cold={A:scene.drawCount('A'),B:scene.drawCount('B'),C:scene.drawCount('C')};
      return {...procedural,instances:objects,instancesByMode:{A:objects,B:objects,C:objects},logicalParts:objects,triangles:scene.manifest.triangles,templateCount:scene.manifest.groups.length,uniqueResidualParts:0,
        bytesA:scene.bytes,bytesB:scene.structuredBytes,bytesC:scene.bytes,residentSceneBuffers:procedural.residentSceneBuffers+scene.residentBytes+(this.real?.residentBytes??0),
        allocationBreakdown:scene.allocationBreakdown,commonGeometryBytes:scene.allocationBreakdown.commonVertices,cachedProceduralBytes:procedural.residentSceneBuffers,cachedRealSceneBytes:this.real?.residentBytes??0,
        materialTextureBytes:this.fullTextures!.bytes,cachedMaterialTextureBytes:this.realTextures?.bytes??0,realSceneCpuBufferBytes:scene.cpuBytes,cachedRealSceneCpuBufferBytes:this.real?.cpuBytes??0,
        rebuildCpuMs:scene.preparationMs,drawCalls:draws[this.mode],drawCallsByMode:draws,coldDrawCallsByMode:cold,batching:scene.batching,materialEdits:scene.materialEdits,sourceDigest:scene.materialIdentity.sourceDigest,transparencyPass:this.hasTransparency,
        fullScene:true,culling:scene.cullingInfo,lod:scene.manifest.lod,fullBatches:scene.batches.length,fullParts:scene.manifest.groups.length,fullElements:scene.elementCount};
    }
    if(this.source==='procedural'||!this.real)return {...procedural,residentSceneBuffers:procedural.residentSceneBuffers+(this.real?.residentBytes??0)+(this.full?.residentBytes??0),cachedRealSceneBytes:this.real?.residentBytes??0,cachedFullSceneBytes:this.full?.residentBytes??0,realSceneCpuBufferBytes:this.real?.cpuBytes??0,cachedFullSceneCpuBufferBytes:this.full?.cpuBytes??0,materialTextureBytes:0,cachedMaterialTextureBytes:(this.realTextures?.bytes??0)+(this.fullTextures?.bytes??0)};
    const objects=this.real.manifest.objects.length,groups=this.real.groups.length,bDraws=this.real.batching?this.real.batchDrawGroups:this.real.legacyDrawGroups;
    const passes=this.hasTransparency?2:1,compositeDraw=this.hasTransparency?1:0;
    return {...procedural,instances:this.mode==='B'?this.real.structuredInstances:objects,instancesByMode:{A:objects,B:this.real.structuredInstances,C:objects},logicalParts:objects,triangles:this.real.manifest.triangles,templateCount:this.mode==='B'?this.analysis!.families.length:groups,uniqueResidualParts:0,
      bytesA:this.real.bytes,bytesB:this.real.structuredBytes,bytesC:this.real.bytes,residentSceneBuffers:procedural.residentSceneBuffers+this.real.residentBytes+(this.full?.residentBytes??0),cachedFullSceneBytes:this.full?.residentBytes??0,cachedFullSceneCpuBufferBytes:this.full?.cpuBytes??0,cachedMaterialTextureBytes:this.fullTextures?.bytes??0,
      allocationBreakdown:{common:this.real.legacyBytes-this.real.extraBytes,AInstances:this.real.bytes-(this.real.legacyBytes-this.real.extraBytes),BTemplates:this.real.extraBytes,BBatch:this.real.batchBytes,BCTransforms:0,CMergedGeometry:0},
      commonGeometryBytes:this.real.legacyBytes-this.real.extraBytes,diagnostic:this.diagnostic,realSceneCpuBufferBytes:this.real.cpuBytes,cachedProceduralBytes:procedural.residentSceneBuffers,rebuildCpuMs:this.real.preparationMs,structuredFamilies:this.analysis?.families.length,structuredDrawGroups:bDraws,batching:this.real.batching,batchBufferBytes:this.real.batchBytes,legacyBBytes:this.real.legacyBytes,materialEdits:this.materialEdits,sourceDigest:this.analysis?.sourceDigest,transparencyPass:this.hasTransparency,drawCalls:passes*(this.mode==='B'?bDraws:this.mode==='C'?groups:objects)+compositeDraw,drawCallsByMode:{A:objects*passes+compositeDraw,B:bDraws*passes+compositeDraw,C:groups*passes+compositeDraw},coldDrawCallsByMode:{A:objects*(passes+1)+compositeDraw,B:bDraws*(passes+1)+compositeDraw,C:groups*(passes+1)+compositeDraw}};
  }
  resize() {
    const [width,height]=renderSize(this.canvas.clientWidth,this.canvas.clientHeight,window.devicePixelRatio,this.device.limits.maxTextureDimension2D,this.profile);
    if(width===this.size[0]&&height===this.size[1])return false;
    this.size=[width,height];this.canvas.width=width;this.canvas.height=height;
    this.depth?.destroy();this.depth=this.device.createTexture({size:[width,height],format:'depth24plus',usage:GPUTextureUsage.RENDER_ATTACHMENT});
    this.accumulation?.destroy();this.revealage?.destroy();
    this.accumulation=this.device.createTexture({size:[width,height],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
    this.revealage=this.device.createTexture({size:[width,height],format:'r8unorm',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
    this.compositeBind=this.device.createBindGroup({layout:this.compositeLayout,entries:[{binding:0,resource:this.accumulation.createView()},{binding:1,resource:this.revealage.createView()}]});return true;
  }
  render(frameMs=0, measure=false, forceShadow=false):{sample:Sample;done:Promise<number|null>} {
    if(this.stopped)throw new Error('GPU остановлен');
    this.renderedFrames++;
    const start=performance.now();this.resize();
    const aspect=this.size[0]/this.size[1];
    const fittedDistance=this.distance*Math.max(1,1.2/aspect);
    const {target,radius}=this.framing;
    const eye=[Math.sin(this.yaw)*Math.cos(this.pitch)*fittedDistance,Math.sin(this.pitch)*fittedDistance,Math.cos(this.yaw)*Math.cos(this.pitch)*fittedDistance].map((v,i)=>v+target[i]);
    const vp=mat4.multiply(mat4.perspective(.65,aspect,.5,10000),mat4.lookAt(eye,target,[0,1,0]));
    if(this.source==='full')this.full?.prepareVisibility(this.culling?frustumPlanes(vp):null);
    const lightVP=mat4.multiply(mat4.ortho(-radius,radius,-radius,radius,1,radius*6),mat4.lookAt([-radius*1.8,radius*3,radius*1.2].map((v,i)=>v+target[i]),target,[0,1,0]));
    const uniforms=new Float32Array(44);uniforms.set(vp);uniforms.set(lightVP,16);uniforms.set([...eye,this.environmentRotation*Math.PI/180],32);uniforms.set([this.partCount,this.diagnostic,this.source!=='procedural'?this.textureMode:0,this.source!=='procedural'?this.environmentMode:0],36);
    uniforms.set([this.iblMode,0,0,0],40);
    this.device.queue.writeBuffer(this.uniform,0,uniforms);
    const encoder=this.device.createCommandEncoder();
    const timed=measure&&!!this.queries&&!this.timestampBusy;
    if(timed)this.timestampBusy=true;
    const passes:PassName[]=[];
    const writes=(name:PassName)=>{const offset=passes.length*2;passes.push(name);return timed?{querySet:this.queries!,beginningOfPassWriteIndex:offset,endOfPassWriteIndex:offset+1}:undefined;};
    // Camera VP and shading-only settings are deliberately excluded. Light VP is
    // included because focusing a family changes the shadow projection.
    const key=[this.source,this.mode,this.mode==='B'&&this.batching,this.sceneRevision,this.diagnostic,this.mode==='B'?this.activeReal?.shadowVersion??0:0,...lightVP].join('|');
    const rebuildShadow=forceShadow||key!==this.shadowKey;
    if(rebuildShadow){
      const shadowPass=encoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:this.shadow.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'},timestampWrites:writes('shadow')});
      this.draw(shadowPass,true);shadowPass.end();
    }
    const pass=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),clearValue:{r:.078,g:.098,b:.11,a:1},loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:this.depth!.createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'},timestampWrites:writes('opaque')});
    pass.setBindGroup(1,this.lightBind);this.draw(pass,false);pass.end();
    if(this.hasTransparency){
      const transparent=encoder.beginRenderPass({colorAttachments:[{view:this.accumulation!.createView(),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'},{view:this.revealage!.createView(),clearValue:[1,1,1,1],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:this.depth!.createView(),depthLoadOp:'load',depthStoreOp:'store'},timestampWrites:writes('glass')});
      transparent.setBindGroup(1,this.lightBind);this.draw(transparent,false,true);transparent.end();
      const composite=encoder.beginRenderPass({colorAttachments:[{view:this.context.getCurrentTexture().createView(),loadOp:'load',storeOp:'store'}],timestampWrites:writes('composite')});
      composite.setPipeline(this.compositePipeline);composite.setBindGroup(0,this.compositeBind!);composite.draw(3);composite.end();
    }
    const queryCount=passes.length*2;
    if(timed){encoder.resolveQuerySet(this.queries!,0,queryCount,this.resolve!,0);encoder.copyBufferToBuffer(this.resolve!,0,this.readback!,0,queryCount*8);}
    this.device.queue.submit([encoder.finish()]);
    this.shadowKey=key;this.lastShadowRebuilt=rebuildShadow;if(rebuildShadow)this.shadowBuilds++;else this.shadowReuses++;
    const sample:Sample={frame:frameMs,cpu:performance.now()-start,gpu:null,shadowRebuilt:rebuildShadow};
    const done=timed?this.readTimestamp(passes).then(t=>{sample.gpuPasses=t.passes;return t.total;}):Promise.resolve(null);
    return {sample,done};
  }
  private draw(pass:GPURenderPassEncoder, shadow:boolean,transparent=false){
    if(this.source==='full'&&this.full){const layer=shadow?0:transparent?2:1;pass.setPipeline((this.mode==='B'&&this.full.batching&&!this.mobile?this.fullBatchPipelines:this.fullPipelines)[layer]);pass.setBindGroup(0,this.bindG);if(!shadow){pass.setBindGroup(1,this.lightBind);pass.setBindGroup(3,this.fullTextures!.bind);}this.full.draw(pass,this.mode,shadow?'shadow':transparent?'glass':'opaque');return;}
    if(this.source==='blender'&&this.real){
      pass.setPipeline(shadow?this.realShadow:transparent?this.realTransparent:this.realPipeline);pass.setBindGroup(0,this.bindG);if(!shadow)pass.setBindGroup(3,this.realTextures!.bind);this.real.draw(pass,this.mode);
      if(this.mode==='B'&&this.real.batching){pass.setPipeline(shadow?this.batchShadow:transparent?this.batchTransparent:this.batchPipeline);pass.setBindGroup(0,this.bindG);if(!shadow){pass.setBindGroup(1,this.lightBind);pass.setBindGroup(3,this.realTextures!.bind);}this.real.drawBatch(pass);}return;
    }
    const pipelines=shadow?this.shadows:this.pipelines;
    pass.setVertexBuffer(0,this.vertex);pass.setIndexBuffer(this.index,'uint16');
    pass.setPipeline(pipelines.A);pass.setBindGroup(0,this.bindG);if(!shadow)pass.setBindGroup(3,this.fallbackTextures.bind);pass.drawIndexed(36,this.groundCount);
    if(this.mode==='A'){
      pass.setPipeline(pipelines.A);pass.setBindGroup(0,this.bindA);pass.drawIndexed(36,this.totalParts);
    } else for(const group of this.groups){
      pass.setPipeline(pipelines[this.mode]);
      if(this.mode==='B'){
        pass.setBindGroup(0,group.bind);pass.drawIndexed(36,group.partCount*group.count);
      }else{
        pass.setBindGroup(0,this.bindG);
        pass.setVertexBuffer(0,group.mesh);pass.setVertexBuffer(1,group.buildings);
        pass.setIndexBuffer(group.indices,'uint32');pass.drawIndexed(group.indexCount,group.count);
      }
    }
  }
  private async readTimestamp(passes:PassName[]){
    try{await this.readback!.mapAsync(GPUMapMode.READ);return decodePassTimestamps(new BigUint64Array(this.readback!.getMappedRange()),passes);}
    finally{if(this.readback?.mapState==='mapped')this.readback.unmap();this.timestampBusy=false;}
  }
  async pixels(forceShadow=false):Promise<Uint8Array>{
    this.render(0,false,forceShadow);
    const width=this.canvas.width,height=this.canvas.height,row=Math.ceil(width*4/256)*256;
    const buffer=this.device.createBuffer({size:row*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try{const encoder=this.device.createCommandEncoder();encoder.copyTextureToBuffer({texture:this.context.getCurrentTexture()},{buffer,bytesPerRow:row},{width,height});this.device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
      const mapped=new Uint8Array(buffer.getMappedRange()), data=new Uint8Array(width*height*4);for(let y=0;y<height;y++)data.set(mapped.subarray(y*row,y*row+width*4),y*width*4);return data;
    } finally {if(buffer.mapState==='mapped')buffer.unmap();buffer.destroy();}
  }
  destroy(){this.stopped=true;this.full?.destroy();this.fullTextures?.destroy();this.real?.destroy();this.realTextures?.destroy();this.environment?.destroy();this.prefiltered?.destroy();this.fallbackTextures?.destroy();this.depth?.destroy();this.accumulation?.destroy();this.revealage?.destroy();this.shadow?.destroy();this.queries?.destroy();this.device?.destroy();}
}
