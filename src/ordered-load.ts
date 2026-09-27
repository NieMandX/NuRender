/** Bounded network overlap, deterministic upload order, and cancellation on consumer failure. */
export async function* orderedLoad<T,R>(items:readonly T[],concurrency:number,load:(item:T,index:number,signal:AbortSignal)=>Promise<R>){
  if(!Number.isInteger(concurrency)||concurrency<1)throw new Error('Invalid concurrency');
  const abort=new AbortController();
  type Result={ok:true;value:R}|{ok:false;error:unknown};
  const pending=new Map<number,Promise<Result>>();let next=0;
  const fill=()=>{while(next<items.length&&pending.size<concurrency){const i=next++;pending.set(i,Promise.resolve().then(()=>load(items[i],i,abort.signal)).then(value=>({ok:true,value} as const),error=>({ok:false,error} as const)));}};
  try{fill();for(let i=0;i<items.length;i++){const result=await pending.get(i)!;pending.delete(i);if(!result.ok)throw result.error;fill();yield result.value;}}
  finally{abort.abort();pending.clear();}
}
