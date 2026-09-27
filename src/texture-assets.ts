import {fetchAsset as fetch} from './asset-fetch';
import {assetUrl} from './asset-url';
import {sourceDigest} from './structured-real';
export type TextureMap={image:number;matrix:number[];uv:string;channel:number;srgb:boolean;strength:number};
export type SourceMaterial={name:string;roughness:number;metallic:number;maps:Partial<Record<'color'|'roughness'|'metallic'|'normal',TextureMap>>};
export type TextureManifest={version:1;sourceDigest:string;groups:{name:string;file:string;corners:number;uvLayer:string;sha256:string}[];images:{file:string;sha256:string;width:number;height:number}[];materials:SourceMaterial[];warnings:{material:string;role:string;reason:string;object?:string}[]};
export const TEXTURE_ROOT=assetUrl('scenes/m8-fragment/');
export async function loadTextureManifest(digest:string,root=TEXTURE_ROOT):Promise<TextureManifest>{
  const r=await fetch(root+'textures.json');if(!r.ok)throw new Error('Нет экспорта текстур Blender');
  const m:TextureManifest=await r.json();
  if(m.version!==1||m.sourceDigest!==digest||!Array.isArray(m.images)||!Array.isArray(m.materials)||!Array.isArray(m.groups))throw new Error('Текстуры относятся к другой геометрии');
  for(const image of m.images)if(!/^textures\/[a-f0-9]+\.(png|jpg)$/.test(image.file)||![256,1024].includes(image.width)||image.height!==image.width)throw new Error('Ожидаются квадратные текстуры 256 или 1024');
  for(const material of m.materials){
    if(![material.roughness,material.metallic].every(x=>Number.isFinite(x)&&x>=0&&x<=1))throw new Error('Неверные параметры исходного материала');
    for(const map of Object.values(material.maps))if(!Number.isInteger(map.image)||!m.images[map.image]||map.matrix.length!==6||!map.matrix.every(Number.isFinite)||!Number.isInteger(map.channel)||map.channel<0||map.channel>3||!Number.isFinite(map.strength))throw new Error('Неверная карта текстуры');
  }
  return m;
}
export async function loadCornerData(m:TextureManifest,index:number,name:string,count:number){
  const g=m.groups[index];if(!g||g.name!==name||g.corners!==count||!/^group-\d+\.texcoords\.bin$/.test(g.file))throw new Error('UV не соответствуют геометрии');
  const r=await fetch(TEXTURE_ROOT+g.file);if(!r.ok)throw new Error('Нет координат текстуры');const b=await r.arrayBuffer();
  if(b.byteLength!==count*16||await sourceDigest([new Uint8Array(b)])!==g.sha256)throw new Error('Повреждены координаты текстуры');
  const values=new Float32Array(b);
  for(let i=0;i<values.length;i+=4)if(!Number.isFinite(values[i])||!Number.isFinite(values[i+1])||!Number.isInteger(values[i+2])||values[i+2]<0||values[i+2]>m.materials.length)throw new Error('Неверный UV или ID материала');
  return values;
}

export class TextureAssets{
  readonly layout:GPUBindGroupLayout;readonly bind:GPUBindGroup;readonly texture:GPUTexture;readonly table:GPUBuffer;
  private constructor(readonly device:GPUDevice,readonly bytes:number,texture:GPUTexture,table:GPUBuffer,layout:GPUBindGroupLayout){
    this.texture=texture;this.table=table;this.layout=layout;
    this.bind=device.createBindGroup({layout,entries:[{binding:0,resource:texture.createView({dimension:'2d-array'})},{binding:1,resource:device.createSampler({addressModeU:'repeat',addressModeV:'repeat',magFilter:'linear',minFilter:'linear',mipmapFilter:'linear',maxAnisotropy:4})},{binding:2,resource:{buffer:table}}]});
  }
  static layout(device:GPUDevice){return device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{viewDimension:'2d-array'}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{}},{binding:2,visibility:GPUShaderStage.FRAGMENT,buffer:{type:'read-only-storage'}}]});}
  static async create(device:GPUDevice,layout:GPUBindGroupLayout,manifest?:TextureManifest,root=TEXTURE_ROOT,resolution=1024,progress:(s:string)=>void=()=>{}){
    if(![256,512,1024].includes(resolution))throw new Error('Unsupported material texture resolution');
    const slots:{image:number;srgb:boolean}[]=[],keys=new Map<string,number>();
    const layer=(map:TextureMap|undefined)=>{
      if(!map)return -1;const key=`${map.image}:${map.srgb}`;
      if(!keys.has(key)){keys.set(key,slots.length);slots.push({image:map.image,srgb:map.srgb});}return keys.get(key)!;
    };
    const data=new Float32Array(((manifest?.materials.length??0)+1)*44);data.fill(0);data.fill(-1,4,8);
    for(const [i,material] of (manifest?.materials??[]).entries()){
      const offset=(i+1)*44,maps=['color','roughness','metallic','normal'].map(role=>material.maps[role as keyof typeof material.maps]);
      data.set([material.roughness,material.metallic,material.maps.normal?.strength??1,1],offset);
      data.set(maps.map(layer),offset+4);data.set([maps[1]?.channel??0,maps[2]?.channel??0,maps[0]?.srgb?1:0,0],offset+8);
      maps.forEach((map,j)=>{const m=map?.matrix??[1,0,0,0,1,0];data.set([m[0],m[1],m[2],0,m[3],m[4],m[5],0],offset+12+j*8);});
    }
    const size=slots.length?resolution:1,levels=Math.log2(size)+1;
    const texture=device.createTexture({label:'Blender material images with mipmaps',size:[size,size,Math.max(1,slots.length)],mipLevelCount:levels,format:'rgba8unorm',viewFormats:['rgba8unorm-srgb'],usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
    const table=device.createBuffer({label:'Imported PBR material table',size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(table,0,data);
    try{
      if(!slots.length)device.queue.writeTexture({texture},new Uint8Array([255,255,255,255]),{bytesPerRow:4},[1,1]);
      for(const [index,slot] of slots.entries()){
        progress(`Текстуры: ${index+1}/${slots.length}`);
        const meta=manifest!.images[slot.image],r=await fetch(root+meta.file);if(!r.ok)throw new Error('Не удалось прочитать '+meta.file);
        const bytes=await r.arrayBuffer();if(await sourceDigest([new Uint8Array(bytes)])!==meta.sha256)throw new Error('Повреждена текстура '+meta.file);
        const bitmap=await createImageBitmap(new Blob([bytes]),{colorSpaceConversion:'none',premultiplyAlpha:'none'});
        try{
          if(bitmap.width!==meta.width||bitmap.height!==meta.height||size>meta.width)throw new Error('Неверный размер текстуры');
          if(size===meta.width)device.queue.copyExternalImageToTexture({source:bitmap},{texture,origin:[0,0,index]},[size,size]);
          else {
            const staging=device.createTexture({size:[meta.width,meta.height],mipLevelCount:Math.log2(meta.width/size)+1,format:'rgba8unorm',viewFormats:['rgba8unorm-srgb'],usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT});
            try{device.queue.copyExternalImageToTexture({source:bitmap},{texture:staging},[meta.width,meta.height]);await generateMips(device,staging,[slot.srgb],Math.log2(meta.width/size)+1);
              const encoder=device.createCommandEncoder();encoder.copyTextureToTexture({texture:staging,mipLevel:Math.log2(meta.width/size)},{texture,origin:[0,0,index]},[size,size]);device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();
            }finally{staging.destroy();}
          }
        }finally{bitmap.close();}
      }
      if(slots.length)await generateMips(device,texture,slots.map(s=>s.srgb),levels);
      const bytes=Array.from({length:levels},(_,l)=>(size>>l)**2*4*Math.max(1,slots.length)).reduce((a,b)=>a+b,0)+table.size;
      return new TextureAssets(device,bytes,texture,table,layout);
    }catch(error){texture.destroy();table.destroy();throw error;}
  }
  destroy(){this.texture.destroy();this.table.destroy();}
}
export async function generateMips(device:GPUDevice,texture:GPUTexture,srgb:boolean[],levels:number,baseFormat:'rgba8unorm'|'rgba16float'='rgba8unorm'){
  const module=device.createShaderModule({code:`
    @group(0) @binding(0) var image:texture_2d<f32>;
    @vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}
    fn load(c:vec2i)->vec4f{return textureLoad(image,min(c,vec2i(textureDimensions(image))-1),0);}
    @fragment fn fs(@builtin(position) p:vec4f)->@location(0) vec4f {let c=vec2i(p.xy)*2;return (load(c)+load(c+vec2i(1,0))+load(c+vec2i(0,1))+load(c+vec2i(1,1)))*.25;}`});
  const pipelines=await Promise.all(([baseFormat,baseFormat==='rgba8unorm'?'rgba8unorm-srgb':'rgba16float'] as const).map(format=>device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format}]}})));
  const encoder=device.createCommandEncoder();
  for(let layer=0;layer<srgb.length;layer++)for(let mip=1;mip<levels;mip++){
    const pipeline=pipelines[srgb[layer]?1:0],format=srgb[layer]?'rgba8unorm-srgb':baseFormat;
    const view=(level:number)=>texture.createView({dimension:'2d',format,baseArrayLayer:layer,arrayLayerCount:1,baseMipLevel:level,mipLevelCount:1});
    const pass=encoder.beginRenderPass({colorAttachments:[{view:view(mip),loadOp:'clear',storeOp:'store'}]});
    pass.setPipeline(pipeline);pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:view(mip-1)}]}));pass.draw(3);pass.end();
  }
  device.queue.submit([encoder.finish()]);await device.queue.onSubmittedWorkDone();
}
