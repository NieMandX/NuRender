/** Retry transient GET failures without retrying missing assets or hiding cancellation. */
export async function fetchAsset(input:RequestInfo|URL,init:RequestInit={}){
  const signal=init.signal;
  for(let attempt=0;attempt<3;attempt++){
    signal?.throwIfAborted();
    try{
      const response=await globalThis.fetch(input,init);
      if(response.ok)return response;
      if(attempt===2||!(response.status===408||response.status===429||response.status>=500))return response;
      await response.body?.cancel();
    }catch(error){
      if(signal?.aborted)throw signal.reason;
      if(attempt===2)throw new Error(`Не удалось загрузить ресурс: ${String(input)}`,{cause:error});
    }
    await new Promise<void>((resolve,reject)=>{
      const finish=()=>{signal?.removeEventListener('abort',cancel);resolve();};
      const timer=setTimeout(finish,250*(attempt+1));
      const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(signal?.reason);};
      signal?.addEventListener('abort',cancel,{once:true});
      if(signal?.aborted)cancel();
    });
  }
  throw new Error('Unreachable asset retry state');
}
