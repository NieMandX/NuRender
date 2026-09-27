/** Conservative translation-only discovery. No vertices are changed by this analysis. */
export const POSITION_TOLERANCE = 0.001; // metres; verified after signature grouping
export type Component = {triangles:number[]; vertices:number[]; origin:number[]; bounds:number[][]; canonical:number[]; canonicalCorners:number[]; signature:string};
export type Family = {id:number; group:number; object:string; copies:number; trianglesPerCopy:number; maxErrorMetres:number; bounds:number[][]; members:{triangles:number[];translation:number[]}[]};
export type RepetitionReport = {version:1;method:string;toleranceMetres:number;minCopies:number;minTriangles:number;sourceDigest:string;analysisMs:number;families:Family[];groups:{labels:string;vertexCount:number;components:number;excluded:boolean}[];summary:{analysedTriangles:number;excludedTriangles:number;repeatedTriangles:number;repeatedComponents:number;families:number;coverage:number}};
export function worldPositions(vertices:Float32Array,m:number[]){
  const p=new Float64Array(vertices.length/10*3);
  for(let i=0;i<vertices.length/10;i++)for(let a=0;a<3;a++)p[i*3+a]=m[a]*vertices[i*10]+m[4+a]*vertices[i*10+1]+m[8+a]*vertices[i*10+2]+m[12+a];
  return p;
}
export function components(vertices:Float32Array,indices:Uint32Array,m:number[]):Component[]{
  const p=worldPositions(vertices,m), n=p.length/3,parent=Int32Array.from({length:n},(_,i)=>i);
  const root=(i:number):number=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
  const join=(a:number,b:number)=>{a=root(a);b=root(b);if(a!==b)parent[b]=a;};
  // Position-only welding reconnects flat-shaded vertex splits. Rounding may miss
  // near neighbours across a bin boundary; this is conservative, not a radius weld.
  const welded=new Map<string,number>();
  for(let i=0;i<n;i++){const k=[0,1,2].map(a=>Math.round(p[i*3+a]/.0001)).join(',');const prev=welded.get(k);if(prev!==undefined)join(i,prev);else welded.set(k,i);}
  for(let i=0;i<indices.length;i+=3){join(indices[i],indices[i+1]);join(indices[i],indices[i+2]);}
  const sets=new Map<number,number[]>();
  for(let i=0;i<indices.length;i+=3){const r=root(indices[i]);if(!sets.has(r))sets.set(r,[]);sets.get(r)!.push(i/3);}
  return [...sets.values()].map(triangles=>{
    const ids=[...new Set(triangles.flatMap(t=>[indices[t*3],indices[t*3+1],indices[t*3+2]]))];
    const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
    for(const v of ids)for(let a=0;a<3;a++){lo[a]=Math.min(lo[a],p[v*3+a]);hi[a]=Math.max(hi[a],p[v*3+a]);}
    const token=(v:number)=>[...[0,1,2].map(a=>Math.round((p[v*3+a]-lo[a])/POSITION_TOLERANCE)),...[3,4,5].map(a=>Math.round(vertices[v*10+a]*1e4)),...[6,7,8,9].map(a=>Math.round(vertices[v*10+a]*1e4))].join(',');
    const rows=triangles.map(t=>{
      const vs=[indices[t*3],indices[t*3+1],indices[t*3+2]],keys=vs.map(token);
      // Cyclic permutations preserve winding; reversing faces does not match.
      let start=0;for(let j=1;j<3;j++)if(keys[j]<keys[start])start=j;
      return {corners:[t*3+start,t*3+(start+1)%3,t*3+(start+2)%3],ids:[vs[start],vs[(start+1)%3],vs[(start+2)%3]],key:[keys[start],keys[(start+1)%3],keys[(start+2)%3]].join(';')};
    }).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
    return {triangles,vertices:ids,origin:lo,bounds:[lo,hi],canonical:rows.flatMap(r=>r.ids),canonicalCorners:rows.flatMap(r=>r.corners),signature:rows.map(r=>r.key).join('|')};
  });
}
export function findFamilies(vertices:Float32Array,indices:Uint32Array,m:number[],group:number,object:string){
  const parts=components(vertices,indices,m),p=worldPositions(vertices,m),buckets=new Map<string,Component[]>();
  for(const c of parts){if(c.triangles.length<4||Math.max(...c.bounds[1].map((x,a)=>x-c.origin[a]))<.2)continue;if(!buckets.has(c.signature))buckets.set(c.signature,[]);buckets.get(c.signature)!.push(c);}
  const families:Family[]=[];
  for(const bucket of buckets.values()){
    // A signature only proposes a match. Every triangle corner must pass metric
    // and attribute checks against the template before joining its family.
    while(bucket.length){const first=bucket.shift()!,accepted=[first];let maxError=0;
      for(let i=bucket.length-1;i>=0;i--){const c=bucket[i];let error=0,valid=true;
        for(let j=0;j<first.canonical.length;j++){const a=first.canonical[j],b=c.canonical[j];let d2=0;for(let k=0;k<3;k++){const d=(p[a*3+k]-first.origin[k])-(p[b*3+k]-c.origin[k]);d2+=d*d;}error=Math.max(error,Math.sqrt(d2));for(let k=3;k<10;k++)if(Math.abs(vertices[a*10+k]-vertices[b*10+k])>1e-4)valid=false;}
        if(valid&&error<=POSITION_TOLERANCE){accepted.push(c);maxError=Math.max(maxError,error);bucket.splice(i,1);}
      }
      if(accepted.length<3)continue;
      const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];for(const c of accepted)for(let a=0;a<3;a++){lo[a]=Math.min(lo[a],c.bounds[0][a]);hi[a]=Math.max(hi[a],c.bounds[1][a]);}
      families.push({id:0,group,object,copies:accepted.length,trianglesPerCopy:first.triangles.length,maxErrorMetres:maxError,bounds:[lo,hi],members:accepted.map(c=>({triangles:c.triangles,translation:c.origin.map((x,a)=>x-first.origin[a])}))});
    }
  }
  return {parts,families};
}
export function familyColor(id:number):number[]{
  if(!id)return [.14,.18,.21];
  const h=(id*.61803398875)%1,s=.68,l=.62;
  const f=(n:number)=>{const k=(n+h*12)%12;return l-s*Math.min(l,1-l)*Math.max(-1,Math.min(k-3,9-k,1));};
  return [f(0),f(8),f(4)];
}
