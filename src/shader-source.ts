import common from './shader-common.wgsl?raw';
import procedural from './shader-procedural.wgsl?raw';
import real from './shader-real.wgsl?raw';
import full from './shader-full.wgsl?raw';
import surface from './shader.wgsl?raw';
import composite from './transparency.wgsl?raw';

export function sceneShaderSource(entryPoint:string,structured=false):string{
  switch(entryPoint){
    case 'vs':case 'shadowVS':case 'vsMerged':case 'shadowMerged':
      // These are two fixed variants; no runtime pipeline override is necessary.
      return common+procedural.replace('const STRUCTURED: bool = false;',`const STRUCTURED: bool = ${structured};`);
    case 'vsReal':case 'shadowReal':case 'vsBatch':case 'shadowBatch':return common+real;
    case 'vsFull':case 'shadowFull':case 'vsMobile':case 'shadowMobile':
    case 'vsMobilePrecise':case 'shadowMobilePrecise':
    case 'vsFullBatch':case 'shadowFullBatch':return common+full;
    case 'fs':case 'fsTransparent':case 'shadowMask':return common+surface;
    case 'compositeVS':case 'compositeFS':return composite;
    default:throw new Error(`Unknown shader entry point: ${entryPoint}`);
  }
}
