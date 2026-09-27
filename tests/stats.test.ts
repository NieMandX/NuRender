import test from 'node:test';
import assert from 'node:assert/strict';
import {decodePassTimestamps,summarizePasses} from '../src/stats.ts';
test('cached shadow timings ignore stale query slots and report omitted passes as zero',()=>{
  const times=new BigUint64Array([1000000n,4000000n,5000000n,7000000n,8000000n,9000000n,123n,99000000n]);
  const warm=decodePassTimestamps(times,['opaque','glass','composite']);
  assert.deepEqual(warm,{total:6,passes:{shadow:0,opaque:3,glass:2,composite:1}});
  assert.deepEqual(decodePassTimestamps(times,['opaque']),{total:3,passes:{shadow:0,opaque:3,glass:0,composite:0}});
  const summaries=summarizePasses([{frame:0,cpu:0,gpu:6,gpuPasses:warm.passes}]);
  assert.deepEqual(summaries.shadow,{median:0,p95:0,count:1});
  assert.deepEqual(summarizePasses([{frame:0,cpu:0,gpu:null}]).shadow,{median:null,p95:null,count:0});
});
