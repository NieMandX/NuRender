import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchAsset} from '../src/asset-fetch.ts';

test('asset GET retries network/503 failures and returns a successful response',async()=>{
 const original=globalThis.fetch;let calls=0;
 globalThis.fetch=async()=>{calls++;if(calls===1)throw new TypeError('network');return new Response(calls===2?'busy':'data',{status:calls===2?503:200});};
 try{assert.equal(await(await fetchAsset('/scene.bin')).text(),'data');assert.equal(calls,3);}finally{globalThis.fetch=original;}
});
test('missing assets do not retry; cancellation interrupts retry delay',async()=>{
 const original=globalThis.fetch;let calls=0;const controller=new AbortController();
 try{
  globalThis.fetch=async()=>{calls++;return new Response('missing',{status:404});};
  assert.equal((await fetchAsset('/missing.bin')).status,404);assert.equal(calls,1);
  globalThis.fetch=async()=>{calls++;queueMicrotask(()=>controller.abort());return new Response('busy',{status:503});};
  await assert.rejects(fetchAsset('/slow.bin',{signal:controller.signal}),{name:'AbortError'});assert.equal(calls,2);
 }finally{globalThis.fetch=original;}
});
