import {fetchAsset as fetch} from './asset-fetch';
import {assetUrl} from './asset-url';
import {generateMips} from './texture-assets';
import {sourceDigest} from './structured-real';
export const HDR_SOURCE={name:'Urban Courtyard 02',author:'Sergej Majboroda / Poly Haven',url:'https://polyhaven.com/a/urban_courtyard_02',license:'CC0',file:assetUrl('environments/urban_courtyard_02_1k.hdr'),sha256:'e67375321c7c2f413bc1a2855f9e4b391181a40fd6a34058bb7fac410d03b59e'};
/** Radiance RGBE modern scanline RLE, -Y/+X orientation. Other variants fail explicitly. */
export function decodeHDR(bytes:Uint8Array){
  let offset=0;
  const line=()=>{const start=offset;while(offset<bytes.length&&bytes[offset]!==10)offset++;if(offset===bytes.length)throw new Error('Truncated HDR header');return new TextDecoder().decode(bytes.subarray(start,offset++)).trim();};
  if(!['#?RADIANCE','#?RGBE'].includes(line()))throw new Error('Not a Radiance HDR');
  let format=false;for(let i=0;i<100;i++){const s=line();if(!s)break;if(s==='FORMAT=32-bit_rle_rgbe')format=true;}
  const resolution=/^-Y (\d+) \+X (\d+)$/.exec(line());if(!format||!resolution)throw new Error('Unsupported HDR format or orientation');
  const height=Number(resolution[1]),width=Number(resolution[2]);
  if(width<8||width>4096||height<1||height>2048)throw new Error('Unsupported HDR dimensions');
  const data=new Float32Array(width*height*4),scan=new Uint8Array(width*4);
  const byte=()=>{if(offset>=bytes.length)throw new Error('Truncated HDR pixels');return bytes[offset++];};
  for(let y=0;y<height;y++){
    if(byte()!==2||byte()!==2||((byte()<<8)|byte())!==width)throw new Error('Unsupported HDR scanline');
    for(let channel=0;channel<4;channel++){
      let x=0;while(x<width){const code=byte(),count=code>128?code-128:code;if(count===0||x+count>width)throw new Error('Invalid HDR run');
        if(code>128){scan.fill(byte(),channel*width+x,channel*width+x+count);x+=count;}
        else for(let i=0;i<count;i++)scan[channel*width+x++]=byte();
      }
    }
    for(let x=0;x<width;x++){const exponent=scan[width*3+x],scale=exponent?2**(exponent-136):0,at=(y*width+x)*4;
      for(let c=0;c<3;c++){const v=(scan[c*width+x]+.5)*scale;if(!Number.isFinite(v)||v>65504)throw new Error('HDR exceeds finite half-float range');data[at+c]=v;}data[at+3]=1;
    }
  }
  return {width,height,data};
}
export function shBasis(x:number,y:number,z:number){return [.2820947918,.4886025119*y,.4886025119*z,.4886025119*x,1.0925484306*x*y,1.0925484306*y*z,.3153915653*(3*z*z-1),1.0925484306*x*z,.5462742153*(x*x-y*y)];}
/** Nine SH coefficients of diffuse irradiance / pi in linear RGB. */
export function diffuseSH(width:number,height:number,data:Float32Array){
  const coefficients=new Float64Array(36),bands=[1,2/3,2/3,2/3,.25,.25,.25,.25,.25];
  for(let y=0;y<height;y++){
    const theta=(y+.5)/height*Math.PI,sin=Math.sin(theta),cos=Math.cos(theta);
    const weight=(Math.cos(y/height*Math.PI)-Math.cos((y+1)/height*Math.PI))*Math.PI*2/width;
    for(let x=0;x<width;x++){const phi=((x+.5)/width-.5)*Math.PI*2,basis=shBasis(Math.cos(phi)*sin,cos,Math.sin(phi)*sin),at=(y*width+x)*4;
      for(let i=0;i<9;i++)for(let c=0;c<3;c++)coefficients[i*4+c]+=data[at+c]*basis[i]*weight*bands[i];
    }
  }
  return new Float32Array(coefficients);
}
export function halfFloat(value:number){
  if(value===0)return 0;
  if(!Number.isFinite(value)||value<0||value>65504)throw new Error('Invalid positive half float');
  if(value<2**-14)return Math.round(value/2**-24);
  const exponent=Math.floor(Math.log2(value)),mantissa=Math.round((value/2**exponent-1)*1024);
  return ((exponent+15)<<10)+mantissa;
}
export class HDREnvironment{
  private constructor(readonly texture:GPUTexture,readonly sh:GPUBuffer,readonly sampler:GPUSampler,readonly bytes:number){}
  static async create(device:GPUDevice){
    const r=await fetch(HDR_SOURCE.file);if(!r.ok)throw new Error('Не загружена HDR-панорама');const bytes=new Uint8Array(await r.arrayBuffer());
    if(await sourceDigest([bytes])!==HDR_SOURCE.sha256)throw new Error('Повреждена HDR-панорама');
    const {width,height,data}=decodeHDR(bytes),levels=1+Math.floor(Math.log2(Math.max(width,height)));
    const texture=device.createTexture({label:'Urban Courtyard HDR environment',size:[width,height],mipLevelCount:levels,format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
    const sh=device.createBuffer({label:'Diffuse environment spherical harmonics',size:144,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    try{
      device.queue.writeTexture({texture},Uint16Array.from(data,halfFloat),{bytesPerRow:width*8},[width,height]);
      device.queue.writeBuffer(sh,0,diffuseSH(width,height,data));await generateMips(device,texture,[false],levels,'rgba16float');
      const size=Array.from({length:levels},(_,l)=>Math.max(1,width>>l)*Math.max(1,height>>l)*8).reduce((a,b)=>a+b,0)+sh.size;
      return new HDREnvironment(texture,sh,device.createSampler({addressModeU:'repeat',addressModeV:'clamp-to-edge',magFilter:'linear',minFilter:'linear',mipmapFilter:'linear'}),size);
    }catch(e){texture.destroy();sh.destroy();throw e;}
  }
  destroy(){this.texture.destroy();this.sh.destroy();}
}
