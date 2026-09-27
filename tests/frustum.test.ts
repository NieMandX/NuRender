import test from 'node:test';import assert from 'node:assert/strict';
import {mat4} from 'wgpu-matrix';
import {frustumPlanes,intersectsFrustum,transformedBounds} from '../src/frustum.ts';
test('WebGPU near clip uses zero; overlapping and near-plane-crossing bounds survive',()=>{
 const p=frustumPlanes(mat4.identity());assert.equal(intersectsFrustum([[-.1,-.1,.1],[.1,.1,.9]],p),true);assert.equal(intersectsFrustum([[-.1,-.1,-.5],[.1,.1,-.1]],p),false);
 assert.equal(intersectsFrustum([[-.1,-.1,-1],[.1,.1,1]],p),true);assert.equal(intersectsFrustum([[2,0,0],[3,1,1]],p),false);assert.equal(intersectsFrustum([[1,0,0],[2,1,1]],p),true);
});
test('affine AABB encloses all corners under rotation, nonuniform scale and reflection',()=>{
 const matrix=mat4.multiply(mat4.translation([30,-7,12]),mat4.multiply(mat4.rotationY(.78),mat4.scaling([-3,2,.5]))),bounds:[number[],number[]]=[[-2,-3,-4],[5,6,7]],world=transformedBounds(bounds,matrix);
 for(let n=0;n<8;n++)for(let row=0;row<3;row++){let value=matrix[12+row];for(let col=0;col<3;col++)value+=matrix[col*4+row]*bounds[(n>>col)&1][col];assert.ok(value>=world[0][row]-1e-5&&value<=world[1][row]+1e-5);}
});
