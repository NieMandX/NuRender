import {defineConfig} from 'vite';
import {readFileSync} from 'node:fs';
export default defineConfig(({mode})=>({
  base:mode==='pages'?'/NuRender/':'/',
  publicDir:mode==='pages'?false:'public',
  plugins:[{name:'third-party-notices',generateBundle(){this.emitFile({type:'asset',fileName:'THIRD_PARTY_NOTICES.md',source:readFileSync(new URL('./THIRD_PARTY_NOTICES.md',import.meta.url),'utf8')});}}],
}));
