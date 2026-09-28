import test from 'node:test';
import assert from 'node:assert/strict';
import {PageCache,projectedError,needsDetail} from '../src/page-cache.ts';
import {splitPages,compactPage} from '../scripts/spatial-pages.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
type Resource={bytes:number;destroyed:boolean;destroy():void};
function resource(bytes:number):Resource{return {bytes,destroyed:false,destroy(){assert.equal(this.destroyed,false,'double destruction');this.destroyed=true;}};}
test('paging reserves memory before upload, limits concurrency and replaces low priority detail',async()=>{
 const waiting=new Map<number,(r:Resource)=>void>(),uploaded:Resource[]=[];
 const c=new PageCache<Resource>(100,id=>new Promise(resolve=>waiting.set(id,resolve)));
 const requested=[{id:1,bytes:40,priority:1},{id:2,bytes:40,priority:2},{id:3,bytes:40,priority:3}];
 c.update(requested);await tick();assert.equal(waiting.size,2);assert.equal(c.info.reservedBytes,80);assert.equal(c.has(1),false);
 for(const id of [2,3]){const r=resource(40);uploaded.push(r);waiting.get(id)!(r);}await tick();assert.equal(c.bytes,80);
 c.update([{id:1,bytes:70,priority:10}]);await tick();assert.ok(uploaded.every(r=>r.destroyed));assert.equal(c.info.reservedBytes,70);
 const r=resource(70);waiting.get(1)!(r);await tick();assert.equal(c.get(1),r);assert.ok(c.peakBytes<=100);c.destroy();assert.equal(r.destroyed,true);
});
test('late uploads after eviction and scene destruction are destroyed, not installed',async()=>{
 const pending:{resolve:(r:Resource)=>void;signal:AbortSignal}[]=[];
 const c=new PageCache<Resource>(100,(_,signal)=>new Promise(resolve=>pending.push({resolve,signal})));
 c.update([{id:1,bytes:40,priority:1}]);await tick();c.update([]);assert.ok(pending[0].signal.aborted);
 const a=resource(40);pending[0].resolve(a);await tick();assert.ok(a.destroyed);assert.equal(c.bytes,0);
 c.update([{id:2,bytes:40,priority:1}]);await tick();c.destroy();assert.ok(pending[1].signal.aborted);
 const b=resource(40);pending[1].resolve(b);await tick();assert.ok(b.destroyed);assert.equal(c.get(2),undefined);
});
test('failed or oversized upload retains fallback and cannot cause a retry loop',async()=>{
 let loads=0;const r=resource(80),c=new PageCache<Resource>(100,async()=>{loads++;return r;});
 const requests=[{id:1,bytes:40,priority:1}];c.update(requests);await tick();assert.ok(r.destroyed);assert.equal(c.info.failedPages,1);assert.equal(c.bytes,0);
 for(let i=0;i<10;i++)c.update(requests);await tick();assert.equal(loads,1);assert.equal(c.info.pendingPages,0);c.destroy();
});
test('detail selection uses view depth, near-plane safety, and hysteresis',()=>{
 const bounds:[[number,number,number],[number,number,number]]=[[40,0,9],[41,1,10]];
 assert.equal(projectedError(bounds,[0,0,0],[0,0,1],900,.1),10);
 assert.equal(projectedError(bounds,[0,0,20],[0,0,1],900,.1),180);
 assert.equal(needsDetail(.9,false),false);assert.equal(needsDetail(.9,true),true);assert.equal(needsDetail(.69,true),false);
});
test('spatial pages cover every oriented triangle exactly once; compact records are bit-identical',()=>{
 const p=new Float32Array([0,0,0,1,0,0,0,1,0,10,0,0,11,0,0,10,1,0]),i=new Uint32Array([3,4,5,0,1,2,1,4,2]);
 const pages=splitPages(p,i,1);assert.equal(pages.length,3);
 assert.deepEqual(pages.map(a=>Array.from(a).join(',')).sort(),['3,4,5','0,1,2','1,4,2'].sort());
 const bytes=Uint8Array.from({length:120},(_,i)=>i);
 for(const page of pages){const compact=compactPage(bytes,page);for(let n=0;n<page.length;n++)assert.deepEqual(compact.vertices.subarray(compact.indices[n]*20,compact.indices[n]*20+20),bytes.subarray(page[n]*20,page[n]*20+20));}
});
