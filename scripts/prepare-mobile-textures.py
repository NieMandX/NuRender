"""Prepare small PBR maps offline; downsample colour in linear light."""
import json,hashlib
from pathlib import Path
import numpy as np
from PIL import Image
root=Path(__file__).resolve().parents[1]/'public/scenes/m8-full';out=root.parent/'m8-mobile'
m=json.loads((out/'textures.json').read_text());original=json.loads((root/'textures.json').read_text());m['materials']=original['materials'];images=[];slots={};(out/'textures').mkdir(exist_ok=True)
for material in m['materials']:
 for tex in material['maps'].values():
  key=(tex['image'],tex['srgb'])
  if key not in slots:
   source=original['images'][tex['image']];raw=(root/source['file']).read_bytes();assert hashlib.sha256(raw).hexdigest()==source['sha256']
   with Image.open(root/source['file']) as im: a=np.asarray(im.convert('RGBA'),dtype=np.float32)/255
   if tex['srgb']:a[:,:,:3]=np.where(a[:,:,:3]<=.04045,a[:,:,:3]/12.92,((a[:,:,:3]+.055)/1.055)**2.4)
   a=a.reshape(256,4,256,4,4).mean(axis=(1,3))
   if tex['srgb']:a[:,:,:3]=np.where(a[:,:,:3]<=.0031308,a[:,:,:3]*12.92,1.055*np.maximum(a[:,:,:3],0)**(1/2.4)-.055)
   name='textures/'+hashlib.sha256((source['sha256']+str(tex['srgb'])+':linear256').encode()).hexdigest()+'.png'
   Image.fromarray(np.clip(np.round(a*255),0,255).astype('uint8')).save(out/name)
   slots[key]=len(images);images.append({'file':name,'width':256,'height':256,'sha256':hashlib.sha256((out/name).read_bytes()).hexdigest()})
  tex['image']=slots[key]
m['images']=images;(out/'textures.json').write_text(json.dumps(m,ensure_ascii=False));print('Mobile texture bytes',sum((out/i['file']).stat().st_size for i in images),'images',len(images))
