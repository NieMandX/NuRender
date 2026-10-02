import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PipelineCompiler,type PipelineSpec} from '../src/pipeline-compiler.ts';

const spec:PipelineSpec={layout:'auto',vertex:{entryPoint:'vs',structured:true},fragment:{entryPoint:'fs',targets:[{format:'bgra8unorm'}]}};
function mockDevice({reject=false,wgsl=false,validation=false}={}){
  const modules:GPUShaderModuleDescriptor[]=[],pipelines:GPURenderPipelineDescriptor[]=[];let scopes=0;
  const device={
    pushErrorScope(){scopes++;},async popErrorScope(){scopes--;return validation?{message:'layout mismatch'}:null;},
    createShaderModule(source:GPUShaderModuleDescriptor){modules.push(source);return {async getCompilationInfo(){return {messages:wgsl?[{type:'error',lineNum:4,linePos:2,message:'invalid WGSL'}]:[]};}};},
    async createRenderPipelineAsync(descriptor:GPURenderPipelineDescriptor){pipelines.push(descriptor);if(reject)throw new Error('Vertex library failed creation');return {};},
  } as unknown as GPUDevice;
  return {device,modules,pipelines,get scopes(){return scopes;}};
}
test('pipelines specialize before compilation and never reuse modules between stages or pipelines',async()=>{
  const gpu=mockDevice();const compiler=new PipelineCompiler(gpu.device,(entry,structured)=>`${entry} ${structured}`);
  await compiler.create(spec);await compiler.create(spec);
  assert.equal(gpu.scopes,0);assert.equal(gpu.modules.length,4);
  assert.deepEqual(gpu.modules.map(module=>module.code),['vs true','fs true','vs true','fs true']);
  const modules=gpu.pipelines.flatMap(p=>[p.vertex.module,p.fragment!.module]);assert.equal(new Set(modules).size,4);
  assert.ok(gpu.pipelines.every(p=>!('constants' in p.vertex)&&!('structured' in p.vertex)));
  assert.deepEqual(compiler.diagnostics.map(record=>record.status),['ready','ready']);
});
test('backend, WGSL and scoped validation errors carry pipeline context and balance error scopes',async()=>{
  for(const options of [{reject:true},{wgsl:true},{validation:true}]){
    const gpu=mockDevice(options),compiler=new PipelineCompiler(gpu.device,()=> 'shader');
    await assert.rejects(compiler.create(spec),/vs \[structured\] \/ fs/);
    assert.equal(gpu.scopes,0);assert.equal(compiler.diagnostics[0].status,'failed');
    assert.match(compiler.diagnostics[0].error!,options.reject?/Vertex library/:options.wgsl?/4:2 invalid WGSL/:/layout mismatch/);
    const copy=compiler.diagnostics;copy[0].status='ready';assert.equal(compiler.diagnostics[0].status,'failed');
  }
});
test('depth-only pipeline compiles no fragment module',async()=>{
  const gpu=mockDevice(),compiler=new PipelineCompiler(gpu.device,()=> 'shader');
  await compiler.create({layout:'auto',vertex:{entryPoint:'shadowVS'}});
  assert.equal(gpu.modules.length,1);assert.equal(gpu.pipelines[0].fragment,undefined);
});
test('shader families have unique resource bindings and separate vertex/fragment stages',()=>{
  const read=(name:string)=>readFileSync(new URL(`../src/${name}.wgsl`,import.meta.url),'utf8');
  for(const name of ['shader-procedural','shader-real','shader-full','shader']){
    const code=read('shader-common')+read(name);
    const bindings=[...code.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)/g)].map(match=>`${match[1]}:${match[2]}`);
    assert.equal(new Set(bindings).size,bindings.length,name);
    assert.doesNotMatch(code,/\boverride\b/);
    assert.doesNotMatch(code,name==='shader'?/@vertex/:/@fragment/);
  }
});
