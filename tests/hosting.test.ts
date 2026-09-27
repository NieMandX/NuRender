import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveAssetPath} from '../src/asset-url.ts';
import {orderedLoad} from '../src/ordered-load.ts';
test('asset URLs respect Pages subpath or explicit external storage',()=>{
 assert.equal(resolveAssetPath('/scenes/a.bin'),'/scenes/a.bin');
 assert.equal(resolveAssetPath('scenes/a.bin','/NuRender/'),'/NuRender/scenes/a.bin');
 assert.equal(resolveAssetPath('/scenes/a.bin','/NuRender/','https://storage.example/assets/v1'),'https://storage.example/assets/v1/scenes/a.bin');
});
test('prefetch stays bounded and yields source order despite out-of-order network completion',async()=>{
 let active=0,peak=0;const result=[];for await(const value of orderedLoad([0,1,2,3,4,5],3,async n=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,n===0?25:2));active--;return n;}))result.push(value);
 assert.deepEqual(result,[0,1,2,3,4,5]);assert.equal(peak,3);
});
test('consumer break cancels pending loads; failure is surfaced without unhandled rejections',async()=>{
 const signals:AbortSignal[]=[];const it=orderedLoad([0,1,2],2,async(n,i,signal)=>{signals.push(signal);return n;});for await(const n of it){assert.equal(n,0);break;}assert.ok(signals.every(s=>s.aborted));
 await assert.rejects(async()=>{for await(const n of orderedLoad([0,1],2,async n=>{if(n===1)throw new Error('network failure');return n;}))void n;},/network failure/);
});
