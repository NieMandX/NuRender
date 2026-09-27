export type PassName='shadow'|'opaque'|'glass'|'composite';
export type Sample = { frame: number; cpu: number; gpu: number | null; shadowRebuilt?:boolean;gpuPasses?:Record<PassName,number> };
export function decodePassTimestamps(t:BigUint64Array,labels:PassName[]){
  const passes:Record<PassName,number>={shadow:0,opaque:0,glass:0,composite:0};let total=0;
  for(const [i,label] of labels.entries()){const duration=Number(t[i*2+1]-t[i*2])/1e6;passes[label]=duration;total+=duration;}return {total,passes};
}
export function summarizePasses(samples:Sample[]){return Object.fromEntries((['shadow','opaque','glass','composite'] as const).map(name=>{const v=samples.flatMap(s=>s.gpuPasses?[s.gpuPasses[name]]:[]);return [name,{median:percentile(v,.5),p95:percentile(v,.95),count:v.length}];}));}
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*p))];
}
export function summarize(samples: Sample[]) {
  return Object.fromEntries((['frame','cpu','gpu'] as const).map(key=>{
    const values=samples.map(s=>s[key]).filter((x):x is number=>x!==null);
    return [key,{median:percentile(values,.5),p95:percentile(values,.95),count:values.length}];
  }));
}
