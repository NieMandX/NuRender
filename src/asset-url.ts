/** Build-time hosting configuration. Never accepts a user-supplied asset origin. */
export function resolveAssetPath(path:string,appBase='/',assetBase=''){
  const base=assetBase||appBase;
  return base.replace(/\/?$/,'/')+path.replace(/^\//,'');
}
export function assetUrl(path:string){return resolveAssetPath(path,import.meta.env?.BASE_URL??'/',import.meta.env?.VITE_ASSET_BASE??'');}
