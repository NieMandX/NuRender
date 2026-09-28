// Triangle partitioning only: no clipping or new positions at page boundaries.
export function splitPages(positions,indices,maxTriangles=4096){
 const centers=Array.from({length:indices.length/3},(_,t)=>[0,1,2].map(a=>(positions[indices[t*3]*3+a]+positions[indices[t*3+1]*3+a]+positions[indices[t*3+2]*3+a])/3));
 const out=[];
 function split(triangles){
  if(triangles.length<=maxTriangles){out.push(Uint32Array.from(triangles.flatMap(t=>[indices[t*3],indices[t*3+1],indices[t*3+2]])));return;}
  const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
  for(const t of triangles)for(let a=0;a<3;a++){lo[a]=Math.min(lo[a],centers[t][a]);hi[a]=Math.max(hi[a],centers[t][a]);}
  const span=hi.map((v,a)=>v-lo[a]),axis=span.indexOf(Math.max(...span));
  triangles.sort((a,b)=>centers[a][axis]-centers[b][axis]||a-b);
  const mid=Math.floor(triangles.length/2);split(triangles.slice(0,mid));split(triangles.slice(mid));
 }
 split(Array.from({length:indices.length/3},(_,i)=>i));return out;
}
// Reuse the exact quantized records and original decoding transform at every LOD.
export function compactPage(bytes,indices){
 const remap=new Map(),vertices=new Uint8Array(bytes.length),out=new Uint16Array(indices.length);let count=0;
 for(let i=0;i<indices.length;i++){const old=indices[i];let at=remap.get(old);if(at===undefined){at=count++;if(at>65535)throw Error('Page exceeds uint16');remap.set(old,at);vertices.set(bytes.subarray(old*20,old*20+20),at*20);}out[i]=at;}
 return {vertices:vertices.slice(0,count*20),indices:out,count};
}
