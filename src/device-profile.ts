export type DeviceProfile='desktop'|'mobile';
export function chooseProfile(requested:string|null,touchPoints:number,userAgent:string,coarsePointer:boolean):DeviceProfile{
  if(requested==='mobile'||requested==='desktop')return requested;
  return /Android|iPhone|iPad|iPod/i.test(userAgent)||(touchPoints>1&&(/Macintosh/i.test(userAgent)||coarsePointer))?'mobile':'desktop';
}
export function renderSize(width:number,height:number,dpr:number,maxDimension:number,profile:DeviceProfile){
  const density=Math.min(dpr,profile==='mobile'?1:2),budget=profile==='mobile'?1_000_000:Infinity;
  const scale=Math.min(density,Math.sqrt(budget/Math.max(1,width*height)),maxDimension/Math.max(1,width,height));
  return [Math.max(1,Math.floor(width*scale)),Math.max(1,Math.floor(height*scale))];
}
