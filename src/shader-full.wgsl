// Full-scene batches share compact position/normal/UV buffers across A/B/C.
struct FullElement { m:mat4x4f, n0:vec4f, n1:vec4f, n2:vec4f, color:vec4f, props:vec4f }
struct FullInput {
  @location(0) position:vec3f, @location(1) normal:vec3f, @location(2) uv:vec2f,
  @location(3) m0:vec4f, @location(4) m1:vec4f, @location(5) m2:vec4f, @location(6) m3:vec4f,
  @location(7) n0:vec4f, @location(8) n1:vec4f, @location(9) n2:vec4f, @location(10) color:vec4f, @location(11) props:vec4f
}
@group(2) @binding(1) var<storage,read> fullElements:array<FullElement>;
fn fullOutput(position:vec3f,normal:vec3f,uv:vec2f,e:FullElement)->Output {
  let world=e.m*vec4f(position,1);let n=normalize(mat3x3f(e.n0.xyz,e.n1.xyz,e.n2.xyz)*normal);
  var out:Output;out.position=u.vp*world;out.normal=n;out.world=world.xyz;out.color=e.color.rgb;out.kind=e.n0.w;
  out.uv=uv;out.sourceMaterial=u32(e.n1.w);out.light=u.lightVP*vec4f(world.xyz+n*.05,1);
  out.pbr=vec3f(e.props.y,e.props.z,e.props.w);out.emission=e.color.rgb*e.props.x;return out;
}
@vertex fn vsFull(input:FullInput)->Output {return fullOutput(input.position,input.normal,input.uv,FullElement(mat4x4f(input.m0,input.m1,input.m2,input.m3),input.n0,input.n1,input.n2,input.color,input.props));}
@vertex fn shadowFull(input:FullInput)->ShadowOutput {var out:ShadowOutput;out.position=u.lightVP*mat4x4f(input.m0,input.m1,input.m2,input.m3)*vec4f(input.position,1);out.kind=input.n0.w;return out;}
struct MobileInput {
  @location(0) position:vec4f, @location(1) normal:vec4f, @location(2) uv:vec2f,
  @location(3) m0:vec4f, @location(4) m1:vec4f, @location(5) m2:vec4f, @location(6) m3:vec4f,
  @location(7) n0:vec4f, @location(8) n1:vec4f, @location(9) n2:vec4f, @location(10) color:vec4f, @location(11) props:vec4f
}
@vertex fn vsMobile(input:MobileInput)->Output {return fullOutput(input.position.xyz,input.normal.xyz,input.uv,FullElement(mat4x4f(input.m0,input.m1,input.m2,input.m3),input.n0,input.n1,input.n2,input.color,input.props));}
@vertex fn shadowMobile(input:MobileInput)->ShadowOutput {var out:ShadowOutput;out.position=u.lightVP*mat4x4f(input.m0,input.m1,input.m2,input.m3)*vec4f(input.position.xyz,1);out.kind=input.n0.w;return out;}
@vertex fn vsFullBatch(@builtin(vertex_index) address:u32)->Output {
  let at=(address&65535u)*8u;let e=fullElements[address>>16u];
  return fullOutput(batchPosition(at),batchPosition(at+3u),vec2f(batchVertices[at+6u],batchVertices[at+7u]),e);
}
@vertex fn shadowFullBatch(@builtin(vertex_index) address:u32)->ShadowOutput {
  let at=(address&65535u)*8u;let e=fullElements[address>>16u];var out:ShadowOutput;out.position=u.lightVP*e.m*vec4f(batchPosition(at),1);out.kind=e.n0.w;return out;
}
@group(2) @binding(0) var<storage,read> batchVertices:array<f32>;
fn batchPosition(v:u32)->vec3f{return vec3f(batchVertices[v],batchVertices[v+1],batchVertices[v+2]);}
