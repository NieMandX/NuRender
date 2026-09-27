"""Offline split-sum GGX preparation of our fixed HDRI, no changes to source image."""
from pathlib import Path
import hashlib, json, math, numpy as np
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'public/environments/prefiltered';OUT.mkdir(exist_ok=True)
SOURCE=ROOT/'public/environments/urban_courtyard_02_1k.hdr'
raw=SOURCE.read_bytes();assert hashlib.sha256(raw).hexdigest()=='e67375321c7c2f413bc1a2855f9e4b391181a40fd6a34058bb7fac410d03b59e'
start=raw.index(b'\n-Y ')+1;end=raw.index(b'\n',start);_,h,_,w=raw[start:end].split();w=int(w);h=int(h);offset=end+1
image=np.empty((h,w,3),np.float32)
for y in range(h):
 assert raw[offset:offset+4]==bytes([2,2,w>>8,w&255]);offset+=4
 scan=np.empty((4,w),np.uint8)
 for c in range(4):
  x=0
  while x<w:
   n=raw[offset];offset+=1
   if n>128:count=n-128;scan[c,x:x+count]=raw[offset];offset+=1
   else:count=n;scan[c,x:x+count]=np.frombuffer(raw[offset:offset+count],np.uint8);offset+=count
   x+=count
 scale=np.where(scan[3]>0,np.exp2(scan[3].astype(np.float32)-136),0)
 image[y]=(scan[:3].T.astype(np.float32)+.5)*scale[:,None]
assert np.isfinite(image).all()
mips=[image]
while min(mips[-1].shape[:2])>1:
 a=mips[-1];mips.append(a.reshape(a.shape[0]//2,2,a.shape[1]//2,2,3).mean(axis=(1,3)))

def lookup(d,lod):
 u=np.arctan2(d[...,2],d[...,0])/(2*np.pi)+.5;v=np.arccos(np.clip(d[...,1],-1,1))/np.pi
 low=np.clip(np.floor(lod).astype(int),0,len(mips)-1);high=np.minimum(low+1,len(mips)-1);fraction=np.clip(lod-low,0,1)
 out=np.zeros(d.shape,np.float32)
 for level,a in enumerate(mips):
  weight=np.where(low==level,1-fraction,0)+np.where(high==level,fraction,0)
  mask=weight>0
  if not mask.any():continue
  xx=u[mask]*a.shape[1]-.5;yy=np.clip(v[mask]*a.shape[0]-.5,0,a.shape[0]-1)
  ix=np.floor(xx).astype(int);iy=np.floor(yy).astype(int);fx=(xx-ix)[:,None];fy=(yy-iy)[:,None]
  color=(a[iy,ix%a.shape[1]]*(1-fx)+a[iy,(ix+1)%a.shape[1]]*fx)*(1-fy)+(a[np.minimum(iy+1,a.shape[0]-1),ix%a.shape[1]]*(1-fx)+a[np.minimum(iy+1,a.shape[0]-1),(ix+1)%a.shape[1]]*fx)*fy
  out[mask]+=color*weight[mask,None]
 return out

def hammersley(count):
 i=np.arange(count,dtype=np.uint32);rev=np.zeros(count,np.uint32)
 for bit in range(32):rev|=((i>>bit)&1)<<(31-bit)
 return (i.astype(np.float32)+.5)/count,rev.astype(np.float64)/2**32

def half_vectors(rough,count):
 x,y=hammersley(count);alpha=rough**2;ct=np.sqrt((1-x)/(1+(alpha*alpha-1)*x));st=np.sqrt(1-ct*ct);phi=2*np.pi*y
 return np.stack([np.cos(phi)*st,np.sin(phi)*st,ct],-1).astype(np.float32)

def face_directions(face,size):
 t=(np.arange(size,dtype=np.float32)+.5)/size*2-1;x,y=np.meshgrid(t,t);one=np.ones_like(x)
 d=[(one,-y,-x),(-one,-y,x),(x,one,y),(x,-one,-y),(x,-y,one),(-x,-y,-one)][face]
 a=np.stack(d,-1).reshape(-1,3);return a/np.linalg.norm(a,axis=-1)[:,None]

size=256;levels=9;records=[];allbytes=bytearray()
for level in range(levels):
 side=max(1,size>>level);rough=level/(levels-1);count=1024
 for face in range(6):
  normals=face_directions(face,side);result=np.zeros((len(normals),4),np.float32);result[:,3]=1
  if level==0:result[:,:3]=lookup(normals,np.zeros(len(normals)))
  else:
   hh=half_vectors(rough,count);local=2*hh[:,2,None]*hh;local[:,2]-=1;nl=np.maximum(local[:,2],0);valid=nl>0;local=local[valid];weights=nl[valid];hh=hh[valid]
   denom=hh[:,2]**2*(rough**4-1)+1;pdf=rough**4/(4*np.pi*denom**2)
   for begin in range(0,len(normals),256):
    n=normals[begin:begin+256];up=np.tile([0,1,0],(len(n),1));up[np.abs(n[:,1])>.99]=[1,0,0]
    tangent=np.cross(up,n);tangent/=np.linalg.norm(tangent,axis=-1)[:,None];bitangent=np.cross(n,tangent)
    directions=tangent[:,None,:]*local[None,:,0,None]+bitangent[:,None,:]*local[None,:,1,None]+n[:,None,:]*local[None,:,2,None]
    texel=2*np.pi*np.pi*np.maximum(np.sqrt(np.maximum(0,1-directions[:,:,1]**2)),.001)/(w*h)
    lod=np.maximum(0,.5*np.log2(1/(count*pdf[None,:]*texel)))
    result[begin:begin+len(n),:3]=(lookup(directions,lod)*weights[None,:,None]).sum(axis=1)/weights.sum()
  assert np.isfinite(result).all() and result.min()>=0
  payload=np.clip(result,0,65504).astype('<f2').tobytes();records.append({'level':level,'face':face,'size':side,'offset':len(allbytes),'length':len(payload)});allbytes.extend(payload)
 print('GGX mip',level,'roughness',rough,flush=True)
(OUT/'specular.bin').write_bytes(allbytes)
# BRDF uses the same exact Smith term as runtime, avoiding a changed direct BRDF.
side=128;samples=2048;x,y=np.meshgrid((np.arange(side)+.5)/side,(np.arange(side)+.5)/side);nv=x.ravel();rough=y.ravel();lut=np.zeros((len(nv),4),np.float32);lut[:,3]=1
for begin in range(0,len(nv),64):
 n=nv[begin:begin+64,None];r=rough[begin:begin+64,None];hx,hy=hammersley(samples);a2=r**4;ct=np.sqrt((1-hx)/(1+(a2-1)*hx));st=np.sqrt(np.maximum(0,1-ct*ct));phi=2*np.pi*hy
 vh=np.sqrt(1-n*n)*np.cos(phi)*st+n*ct;nl=2*vh*ct-n
 smith=lambda c:2*c/np.maximum(c+np.sqrt(a2+(1-a2)*c*c),1e-8)
 weight=np.where((nl>0)&(vh>0),smith(n)*smith(np.maximum(nl,0))*np.maximum(vh,0)/np.maximum(ct*n,1e-8),0)
 fresnel=(1-np.clip(vh,0,1))**5;lut[begin:begin+len(n),0]=((1-fresnel)*weight).mean(axis=1);lut[begin:begin+len(n),1]=(fresnel*weight).mean(axis=1)
assert np.isfinite(lut).all() and lut.min()>=0
lutbytes=lut.astype('<f2').tobytes();(OUT/'brdf.bin').write_bytes(lutbytes)
meta={'version':1,'sourceSHA256':hashlib.sha256(raw).hexdigest(),'size':size,'levels':levels,'specularSamples':1024,'brdfSize':side,'brdfSamples':samples,'format':'rgba16float','specularSHA256':hashlib.sha256(allbytes).hexdigest(),'brdfSHA256':hashlib.sha256(lutbytes).hexdigest(),'records':records}
(OUT/'manifest.json').write_text(json.dumps(meta,indent=2));print('Prepared',len(allbytes)+len(lutbytes),'bytes',flush=True)
