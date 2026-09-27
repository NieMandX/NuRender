export type Detail = 'full' | 'medium' | 'mass';
export type Mode = 'A' | 'B' | 'C';
export const MODES: Mode[] = ['A','B','C'];
export type Part = { position: number[]; size: number[]; color: number[]; tint: boolean };
export type Building = { x: number; z: number; heightScale: number; color: number[] };
export const STRIDE = 12; // three vec4, 48 bytes
const wall = [0.66, 0.51, 0.38], glass = [0.10, 0.18, 0.20];
// Dyadic dimensions make equivalent arithmetic orders exactly representable in
// float32. This controls numerical noise in image comparisons, not scene quality.
const snap = (x: number) => Math.round(x * 64) / 64;
export function template(detail: Detail, variant = 0): Part[] {
  const parts: Part[] = [];
  const floors = [8, 5, 11, 7][variant % 4], cols = [6, 5, 4, 7][variant % 4];
  const width = [13, 15, 10, 14][variant % 4], depth = [11, 10, 13, 12][variant % 4];
  const height = floors * 3 + 1;
  const box = (position: number[], size: number[], color: number[], tint = false) => parts.push({position:position.map(snap), size:size.map(snap), color, tint});
  box([0, height/2, 0], [width, height, depth], wall, true);
  box([0, .3, 0], [width+1.2, .6, depth+1.2], [.40,.41,.39]);
  box([0,height+.2,0],[width+.6,.5,depth+.6],[.56,.56,.51]);
  box([0,height+.49,0],[width-.5,.1,depth-.5],[.22,.25,.26]);
  box([-width/4,height+1,variant/8],[2,1.2,2],[.46,.49,.49]);
  box([width/4,height+.9,-1],[2.5,1,1.5],[.46,.49,.49]);
  if (detail === 'mass') return parts;
  for (let face=0;face<4;face++) {
    const front=face<2, sign=face%2?-1:1, span=front?width:depth;
    const step=(span-.7)/cols;
    for(let floor=0;floor<floors;floor++) for(let col=0;col<cols;col++) {
      const u=(col-(cols-1)/2)*step, y=1.6+floor*3;
      const pos=(v:number,h:number,d:number)=>front?[v,h,sign*d]:[sign*d,h,v];
      const size=(w:number,h:number,d:number)=>front?[w,h,d]:[d,h,w];
      const edge=(front?depth:width)/2+.04;
      box(pos(u,y,edge),size(step*.66,2.15,.12),glass);
      if(detail==='full') {
        box(pos(u,y-1.15,edge+.12),size(step*.8,.16,.4),[.63,.63,.57]);
        box(pos(u,y,edge+.1),size(.07,2.15,.13),[.47,.48,.43]);
      }
    }
  }
  return parts;
}
export function buildings(count: number): Building[] {
  const side = Math.ceil(Math.sqrt(count));
  return Array.from({length:count}, (_, i) => ({x: (i % side - (side - 1) / 2) * 21, z: (Math.floor(i / side) - (side - 1) / 2) * 19,
    heightScale: [0.75, 1, 1.25, 0.875, 1.125][i % 5], color: i % 3 === 0 ? [0.70, 0.39, 0.25] : i % 3 === 1 ? [0.76, 0.72, 0.61] : [0.48, 0.54, 0.52]}));
}
export function packTemplate(parts: Part[]): Float32Array<ArrayBuffer> {
  return new Float32Array(parts.flatMap(p => [...p.position, p.tint ? 1 : 0, ...p.size, 0, ...p.color, 0]));
}
export function packBuildings(items: Building[]): Float32Array<ArrayBuffer> {
  return new Float32Array(items.flatMap(b => [b.x, 0, b.z, b.heightScale, ...b.color, 0]));
}
export function expand(parts: Part[], items: Building[]): Float32Array<ArrayBuffer> {
  const data = new Float32Array(parts.length * items.length * STRIDE);
  let offset = 0;
  const f = Math.fround;
  for (const b of items) for (const p of parts) {
    data.set([f(f(p.position[0]) + f(b.x)), f(f(p.position[1]) * f(b.heightScale)), f(f(p.position[2]) + f(b.z)), 0,
      f(p.size[0]), f(f(p.size[1]) * f(b.heightScale)), f(p.size[2]), 0, ...(p.tint ? b.color : p.color), 0], offset);
    offset += STRIDE;
  }
  return data;
}
export function ground(count: number): Float32Array<ArrayBuffer> {
  const side = Math.ceil(Math.sqrt(count));
  const parts: Part[] = [{position:[0,-0.3,0],size:[side*21+12,0.6,side*19+12],color:[0.18,0.22,0.23],tint:false}];
  for (const b of buildings(count)) parts.push({position:[b.x,0.05,b.z],size:[16.6,0.10,14.6],color:[0.34,0.37,0.36],tint:false});
  return packTemplate(parts);
}
export function cube() {
  const vertices: number[] = [], indices: number[] = [];
  const faces = [
    [[1,0,0],[0,0,-1],[0,1,0]], [[-1,0,0],[0,0,1],[0,1,0]],
    [[0,1,0],[1,0,0],[0,0,-1]], [[0,-1,0],[1,0,0],[0,0,1]],
    [[0,0,1],[1,0,0],[0,1,0]], [[0,0,-1],[-1,0,0],[0,1,0]],
  ];
  for (const [n,u,v] of faces) {
    const start=vertices.length/6;
    for (const [a,b] of [[-1,-1],[1,-1],[1,1],[-1,1]]) vertices.push(...n.map((x,i)=>(x+a*u[i]+b*v[i])*0.5), ...n);
    indices.push(start,start+1,start+2,start,start+2,start+3);
  }
  return {vertices:new Float32Array(vertices),indices:new Uint16Array(indices)};
}

export type SceneGroup = {parts: Part[]; items: Building[]; variant: number};
export function sceneGroups(count: number, detail: Detail, types: number): SceneGroup[] {
  if(!Number.isInteger(types)||types<1||types>count) throw new Error('Invalid template count');
  const items=buildings(count);
  return Array.from({length:types},(_,variant)=>({variant,parts:template(detail,variant),items:items.filter((_,i)=>i%types===variant)}));
}
export function commonParts(count:number, detail:Detail, types:number):Float32Array<ArrayBuffer>{
  const base=ground(count);
  if(detail==='mass') return base;
  const residual:Part[]=[];
  buildings(count).forEach((b,i)=>{
    const variant=i%types, depth=[11,10,13,12][variant%4];
    const width=2+(i%13)/8, offset=((i*7)%17-8)/4;
    // Per-building bespoke entrance canopies and signs, identical in all modes.
    residual.push({position:[b.x+offset,3, b.z+depth/2+.75],size:[width,.25,1.5],color:[.27,.29,.28],tint:false});
    residual.push({position:[b.x+offset,2.5,b.z+depth/2+.125],size:[width-.25,.375,.125],color:[.62,.43+(i%7)/64,.23],tint:false});
  });
  return concat([base,packTemplate(residual)]);
}
export function concat(arrays:Float32Array<ArrayBuffer>[]):Float32Array<ArrayBuffer>{
  const out=new Float32Array(arrays.reduce((n,a)=>n+a.length,0));let cursor=0;
  for(const a of arrays){out.set(a,cursor);cursor+=a.length;}return out;
}
// Baseline C: an ordinary merged indexed mesh per building type. Vertex data
// contains baked positions, normals, per-part colour, and one tint selector.
export function mergedMesh(parts:Part[]) {
  const unit=cube();const vertices=new Float32Array(parts.length*24*10);
  const indices=new Uint32Array(parts.length*36);
  for(let p=0;p<parts.length;p++) {
    const part=parts[p];
    for(let v=0;v<24;v++) {
      const source=v*6, target=(p*24+v)*10;
      for(let axis=0;axis<3;axis++)vertices[target+axis]=Math.fround(Math.fround(unit.vertices[source+axis]*Math.fround(part.size[axis]))+Math.fround(part.position[axis]));
      vertices.set(unit.vertices.subarray(source+3,source+6),target+3);
      vertices.set([...part.color,part.tint?1:0],target+6);
    }
    for(let j=0;j<36;j++)indices[p*36+j]=p*24+unit.indices[j];
  }
  return {vertices,indices};
}
