export function comparePixels(reference:Uint8Array,candidate:Uint8Array){
  if(reference.length!==candidate.length||reference.length===0)throw new Error('Image dimensions do not match');
  let max=0,sum=0,changed=0,changedPixels=0;
  for(let i=0;i<reference.length;i+=4){let different=false;for(let c=0;c<3;c++){const d=Math.abs(reference[i+c]-candidate[i+c]);max=Math.max(max,d);sum+=d;if(d){changed++;different=true;}}if(different)changedPixels++;}
  return {maxChannelDifference:max,meanAbsoluteChannelDifference:sum/(reference.length/4*3),changedChannels:changed,changedPixels,totalPixels:reference.length/4,changedPixelFraction:changedPixels/(reference.length/4),exact:changed===0};
}
