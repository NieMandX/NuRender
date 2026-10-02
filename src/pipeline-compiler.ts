type VertexSpec=Omit<GPUVertexState,'module'|'constants'|'entryPoint'>&{entryPoint:string;structured?:boolean};
type FragmentSpec=Omit<GPUFragmentState,'module'|'constants'|'entryPoint'>&{entryPoint:string};
export type PipelineSpec=Omit<GPURenderPipelineDescriptor,'vertex'|'fragment'>&{vertex:VertexSpec;fragment?:FragmentSpec};
export type ShaderSource=(entryPoint:string,structured:boolean)=>string;
export type PipelineDiagnostic={label:string;vertex:string;fragment?:string;status:'compiling'|'ready'|'failed';ms:number;error?:string};

/** Fresh, stage-specific modules keep specialization and backend compilation isolated. */
export class PipelineCompiler {
  private records:PipelineDiagnostic[]=[];
  get diagnostics(){return this.records.map(record=>({...record}));}
  constructor(private device:GPUDevice,private source:ShaderSource){}
  async create(spec:PipelineSpec):Promise<GPURenderPipeline>{
    const {structured=false,...vertex}=spec.vertex;
    const label=spec.label??`${vertex.entryPoint}${structured?' [structured]':''} / ${spec.fragment?.entryPoint??'depth'}`;
    const record:PipelineDiagnostic={label,vertex:vertex.entryPoint,fragment:spec.fragment?.entryPoint,status:'compiling',ms:0};
    this.records.push(record);
    const start=performance.now();
    let result:GPURenderPipeline|undefined,failure:unknown;
    this.device.pushErrorScope('validation');
    try{
      const compile=async(entryPoint:string,stage:string)=>{
        const module=this.device.createShaderModule({label:`${label}: ${stage}`,code:this.source(entryPoint,structured)});
        const errors=(await module.getCompilationInfo()).messages.filter(message=>message.type==='error');
        if(errors.length)throw new Error(`${stage}: ${errors.map(message=>`${message.lineNum}:${message.linePos} ${message.message}`).join('\n')}`);
        return module;
      };
      const vertexModule=await compile(vertex.entryPoint,'vertex');
      const fragment=spec.fragment?{...spec.fragment,module:await compile(spec.fragment.entryPoint,'fragment')}:undefined;
      result=await this.device.createRenderPipelineAsync({...spec,label,vertex:{...vertex,module:vertexModule},fragment});
    }catch(error){failure=error;}
    finally{
      // Balance scopes even if the backend rejects createRenderPipelineAsync.
      try{const error=await this.device.popErrorScope();if(error&&!failure)failure=new Error(error.message);}
      catch(error){failure??=error;}
      record.ms=performance.now()-start;
    }
    if(failure||!result){
      record.status='failed';record.error=failure instanceof Error?failure.message:String(failure??'Pipeline was not created');
      throw new Error(`Не удалось подготовить шейдер: ${label}\n${record.error}`);
    }
    record.status='ready';return result;
  }
}
