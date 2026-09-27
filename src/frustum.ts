export type Bounds=[number[],number[]];
export type Plane=[number,number,number,number];
export function geometryBounds(vertices:Float32Array,stride=8):Bounds{
 const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];for(let i=0;i<vertices.length;i+=stride)for(let a=0;a<3;a++){lo[a]=Math.min(lo[a],vertices[i+a]);hi[a]=Math.max(hi[a],vertices[i+a]);}return [lo,hi];
}
export function transformedBounds([lo,hi]:Bounds,m:ArrayLike<number>):Bounds{
 const center=lo.map((x,i)=>(x+hi[i])*.5),extent=lo.map((x,i)=>(hi[i]-x)*.5);
 const c=[0,1,2].map(row=>m[12+row]+center.reduce((s,v,col)=>s+m[col*4+row]*v,0));
 const e=[0,1,2].map(row=>extent.reduce((s,v,col)=>s+Math.abs(m[col*4+row])*v,0));return [c.map((v,i)=>v-e[i]),c.map((v,i)=>v+e[i])];
}
/** Column-major matrix; WebGPU clips z to [0,w], unlike OpenGL's [-w,w]. */
export function frustumPlanes(m:ArrayLike<number>):Plane[]{
 const row=(i:number)=>[m[i],m[i+4],m[i+8],m[i+12]];const w=row(3),x=row(0),y=row(1),z=row(2);
 return [w.map((v,i)=>v+x[i]),w.map((v,i)=>v-x[i]),w.map((v,i)=>v+y[i]),w.map((v,i)=>v-y[i]),z,w.map((v,i)=>v-z[i])].map(p=>{const n=Math.hypot(p[0],p[1],p[2]);return p.map(v=>v/n) as Plane;});
}
export function intersectsFrustum([lo,hi]:Bounds,planes:Plane[]){
 const epsilon=1e-4+Math.max(Math.abs(lo[0]),Math.abs(lo[1]),Math.abs(lo[2]),Math.abs(hi[0]),Math.abs(hi[1]),Math.abs(hi[2]))*1e-6;
 for(const p of planes)if(p[3]+p[0]*(p[0]>=0?hi[0]:lo[0])+p[1]*(p[1]>=0?hi[1]:lo[1])+p[2]*(p[2]>=0?hi[2]:lo[2]) < -epsilon)return false;
 return true;
}
