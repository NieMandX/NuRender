import {readFile,readdir,stat} from 'node:fs/promises';
const html=await readFile('dist/index.html','utf8');if(!html.includes('/NuRender/assets/'))throw new Error('Pages base path is missing');
const tree=await readdir('dist');if(tree.includes('scenes')||tree.includes('environments'))throw new Error('Models must be served from Object Storage');
const notices=await readFile('dist/THIRD_PARTY_NOTICES.md','utf8');if(!notices.includes('Arseny Kapoulkine')||!notices.includes('Gregg Tavares'))throw new Error('Dependency notices are missing');
const js=(await readdir('dist/assets')).filter(n=>n.endsWith('.js'));const source=(await Promise.all(js.map(n=>readFile('dist/assets/'+n,'utf8')))).join('');if(!source.includes('https://storage.yandexcloud.net/maragojeep/nurender/assets/v0.14.0/'))throw new Error('Asset origin is missing');
if((await Promise.all(js.map(n=>stat('dist/assets/'+n)))).reduce((n,s)=>n+s.size,0)>1_000_000)throw new Error('Unexpectedly large application bundle');
console.log('Pages subpath, external assets and app bundle budget verified');
