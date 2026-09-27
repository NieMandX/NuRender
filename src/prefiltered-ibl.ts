import {fetchAsset as fetch} from './asset-fetch';
import {assetUrl} from './asset-url';
import {sourceDigest} from './structured-real';
import {HDR_SOURCE} from './hdr-environment';
type Metadata={version:number;sourceSHA256:string;size:number;levels:number;brdfSize:number;specularSHA256:string;brdfSHA256:string;records:{level:number;face:number;size:number;offset:number;length:number}[]};
export function validatePrefiltered(meta:Metadata,specular:ArrayBuffer,brdf:ArrayBuffer){
  if(meta.version!==1||meta.sourceSHA256!==HDR_SOURCE.sha256||meta.size!==256||meta.levels!==9||meta.brdfSize!==128||brdf.byteLength!==128*128*8)throw new Error('Invalid prefiltered environment');
  let offset=0;
  for(let level=0;level<9;level++)for(let face=0;face<6;face++){
    const r=meta.records[level*6+face],size=Math.max(1,256>>level),length=size*size*8;
    if(!r||r.level!==level||r.face!==face||r.size!==size||r.offset!==offset||r.length!==length)throw new Error('Invalid environment face');offset+=length;
  }
  if(meta.records.length!==54||specular.byteLength!==offset)throw new Error('Invalid environment size');
}
export class PrefilteredIBL{
  private constructor(readonly texture:GPUTexture,readonly lut:GPUTexture,readonly sampler:GPUSampler,readonly bytes:number){}
  static async create(device:GPUDevice){
    const root=assetUrl('environments/prefiltered/');
    const responses=await Promise.all(['manifest.json','specular.bin','brdf.bin'].map(f=>fetch(root+f)));if(responses.some(r=>!r.ok))throw new Error('Не загружено подготовленное HDR-окружение');
    const meta:Metadata=await responses[0].json(),spec=await responses[1].arrayBuffer(),brdf=await responses[2].arrayBuffer();validatePrefiltered(meta,spec,brdf);
    if(await sourceDigest([new Uint8Array(spec)])!==meta.specularSHA256||await sourceDigest([new Uint8Array(brdf)])!==meta.brdfSHA256)throw new Error('Повреждено подготовленное HDR-окружение');
    const texture=device.createTexture({label:'Prefiltered GGX cubemap',size:[256,256,6],mipLevelCount:9,format:'rgba16float',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});
    const lut=device.createTexture({label:'Integrated Smith GGX BRDF',size:[128,128],format:'rgba16float',usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});
    try{
      for(const r of meta.records)device.queue.writeTexture({texture,mipLevel:r.level,origin:[0,0,r.face]},new Uint8Array(spec,r.offset,r.length),{bytesPerRow:r.size*8},[r.size,r.size]);
      device.queue.writeTexture({texture:lut},brdf,{bytesPerRow:128*8},[128,128]);
      return new PrefilteredIBL(texture,lut,device.createSampler({magFilter:'linear',minFilter:'linear',mipmapFilter:'linear'}),spec.byteLength+brdf.byteLength);
    }catch(e){texture.destroy();lut.destroy();throw e;}
  }
  destroy(){this.texture.destroy();this.lut.destroy();}
}
