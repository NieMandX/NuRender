import type {Bounds} from './frustum';
export type PageRequest={id:number;bytes:number;priority:number};
export type PageResource={bytes:number;destroy():void};
/** A camera-space near bound avoids underestimating error at the screen edges. */
export function projectedError(bounds:Bounds,eye:number[],forward:number[],focalPixels:number,errorWorld:number){
 const depth=forward.reduce((s,d,a)=>s+d*((d>=0?bounds[0][a]:bounds[1][a])-eye[a]),0);
 return errorWorld*focalPixels/Math.max(.5,depth);
}
export function needsDetail(errorPixels:number,retained:boolean){return errorPixels>(retained?.7:1);}

/** A bounded fine-geometry cache. The caller always owns a permanent coarse fallback. */
export class PageCache<T extends PageResource>{
 private resident=new Map<number,T>();private pending=new Map<number,{bytes:number;abort:AbortController}>();
 private wanted=new Map<number,PageRequest>();private failures=new Map<number,string>();private dead=false;
 peakBytes=0;loads=0;evictions=0;
 requestedPages=0;
 constructor(readonly budgetBytes:number,private load:(id:number,signal:AbortSignal)=>Promise<T>,private changed:()=>void=()=>{},readonly concurrency=2){}
 get(id:number){return this.resident.get(id);}
 has(id:number){return this.resident.has(id)||this.pending.has(id);}
 get bytes(){return [...this.resident.values()].reduce((s,r)=>s+r.bytes,0);}
 get reservedBytes(){return [...this.pending.values()].reduce((s,r)=>s+r.bytes,0);}
 get info(){return {budgetBytes:this.budgetBytes,residentBytes:this.bytes,reservedBytes:this.reservedBytes,peakBytes:this.peakBytes,residentPages:this.resident.size,pendingPages:this.pending.size,wantedPages:this.wanted.size,budgetLimitedPages:Math.max(0,this.requestedPages-this.wanted.size),failedPages:this.failures.size,lastError:[...this.failures.values()].at(-1)??null,loads:this.loads,evictions:this.evictions};}
 update(requests:PageRequest[]){
  if(this.dead)return;
  const wanted=new Map<number,PageRequest>();let bytes=0;
  for(const r of [...requests].sort((a,b)=>b.priority-a.priority||a.id-b.id)){
   if(!Number.isSafeInteger(r.bytes)||r.bytes<1||wanted.has(r.id))continue;
   if(bytes+r.bytes<=this.budgetBytes){wanted.set(r.id,r);bytes+=r.bytes;}
  }
  this.requestedPages=requests.length;this.wanted=wanted;
  for(const [id,p] of this.pending)if(!wanted.has(id))p.abort.abort();
  let changed=false;for(const [id,r] of this.resident)if(!wanted.has(id)){r.destroy();this.resident.delete(id);this.evictions++;changed=true;}
  if(changed)this.changed();this.pump();
 }
 private pump(){
  if(this.dead)return;
  for(const r of this.wanted.values()){
   if(this.pending.size>=this.concurrency)break;
   if(this.has(r.id)||this.failures.has(r.id)||this.bytes+this.reservedBytes+r.bytes>this.budgetBytes)continue;
   const pending={bytes:r.bytes,abort:new AbortController()};this.pending.set(r.id,pending);
   this.peakBytes=Math.max(this.peakBytes,this.bytes+this.reservedBytes);
   void Promise.resolve().then(()=>this.load(r.id,pending.abort.signal)).then(resource=>{
    if(this.dead||pending.abort.signal.aborted||!this.wanted.has(r.id)){resource.destroy();return;}
    if(resource.bytes!==r.bytes){resource.destroy();throw Error('Page size does not match its reservation');}
    this.resident.set(r.id,resource);this.loads++;
   }).catch(error=>{if(!this.dead&&!pending.abort.signal.aborted)this.failures.set(r.id,String(error));}).finally(()=>{
    this.pending.delete(r.id);if(!this.dead){this.changed();this.pump();}
   });
  }
 }
 destroy(){if(this.dead)return;this.dead=true;for(const p of this.pending.values())p.abort.abort();for(const r of this.resident.values())r.destroy();this.resident.clear();this.wanted.clear();}
}
