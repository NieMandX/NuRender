// Position quantization is local to each part; UVs retain full float32 precision.
export function compactMobile(vertices, indices, instances) {
 const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
 for(let i=0;i<vertices.length;i+=8)for(let a=0;a<3;a++){lo[a]=Math.min(lo[a],vertices[i+a]);hi[a]=Math.max(hi[a],vertices[i+a]);}
 const scale=hi.map((h,a)=>h-lo[a]),packed=new Uint8Array(vertices.length/8*20),view=new DataView(packed.buffer),lookup=new Map(),remap=new Uint16Array(vertices.length/8);let count=0,maxNormalError=0;
 for(let i=0;i<vertices.length/8;i++){
  const pos=lo.map((l,a)=>Math.round((vertices[i*8+a]-l)/(scale[a]||1)*65535));
  const normal=[0,1,2].map(a=>Math.round(Math.max(-1,Math.min(1,vertices[i*8+3+a]))*127));
  const key=[...pos,...normal,vertices[i*8+6],vertices[i*8+7]].join(',');let at=lookup.get(key);
  if(at===undefined){at=count++;lookup.set(key,at);for(let a=0;a<3;a++){view.setUint16(at*20+a*2,pos[a],true);view.setInt8(at*20+8+a,normal[a]);}view.setFloat32(at*20+12,vertices[i*8+6],true);view.setFloat32(at*20+16,vertices[i*8+7],true);}
  remap[i]=at;maxNormalError=Math.max(maxNormalError,Math.hypot(...normal.map((n,a)=>n/127-vertices[i*8+3+a])));
 }
 const transformed=instances.map(m=>{const n=m.slice();for(let row=0;row<4;row++){n[12+row]=m[12+row]+lo.reduce((sum,v,col)=>sum+m[col*4+row]*v,0);for(let col=0;col<3;col++)n[col*4+row]=m[col*4+row]*scale[col];}return n;});
 const maxWorldPositionError=Math.max(...instances.map(m=>Math.hypot(...[0,1,2].map(row=>scale.reduce((sum,s,col)=>sum+Math.abs(m[col*4+row])*s/131070,0)))));
 return {vertices:packed.slice(0,count*20),indices:Uint16Array.from(indices,i=>remap[i]),instances:transformed,count,maxWorldPositionError,maxNormalError};
}
