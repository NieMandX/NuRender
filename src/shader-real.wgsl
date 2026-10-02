struct RealInput {
  @location(0) position:vec3f, @location(1) normal:vec3f, @location(2) color:vec4f,
  @location(3) m0:vec4f, @location(4) m1:vec4f, @location(5) m2:vec4f, @location(6) m3:vec4f,
  @location(7) n0:vec4f, @location(8) n1:vec4f, @location(9) n2:vec4f, @location(10) textureInfo:vec4f
}
@vertex fn vsReal(input:RealInput)->Output {
  let world=mat4x4f(input.m0,input.m1,input.m2,input.m3)*vec4f(input.position,1);
  let normal=normalize(mat3x3f(input.n0.xyz,input.n1.xyz,input.n2.xyz)*input.normal);
  var out:Output;
  out.position=u.vp*world;out.normal=normal;out.color=input.color.xyz;out.world=world.xyz;out.kind=input.color.w;out.uv=input.textureInfo.xy;out.sourceMaterial=u32(input.textureInfo.z);
  out.light=u.lightVP*vec4f(world.xyz+normal*.05,1);return out;
}
@vertex fn shadowReal(input:RealInput)->ShadowOutput {
  var out:ShadowOutput;out.position=u.lightVP*mat4x4f(input.m0,input.m1,input.m2,input.m3)*vec4f(input.position,1);out.kind=input.color.w;return out;
}

// B batch: 16 bits template-vertex address + 16 bits element-table address.
struct Element { m:mat4x4f, n0:vec4f, n1:vec4f, n2:vec4f, ids:vec4u }
@group(2) @binding(0) var<storage,read> batchVertices:array<f32>;
@group(2) @binding(1) var<storage,read> elements:array<Element>;
@group(2) @binding(2) var<storage,read> materials:array<vec4f>;
@group(2) @binding(3) var<storage,read> batchTexcoords:array<vec4f>;
@group(2) @binding(4) var<storage,read> batchTexcoordOffsets:array<vec2u>;
fn batchPosition(v:u32)->vec3f{return vec3f(batchVertices[v],batchVertices[v+1],batchVertices[v+2]);}
@vertex fn vsBatch(@builtin(vertex_index) address:u32)->Output {
  let v=(address & 65535u)*10u;let e=elements[address>>16u];
  let world=e.m*vec4f(batchPosition(v),1);
  let normal=normalize(mat3x3f(e.n0.xyz,e.n1.xyz,e.n2.xyz)*batchPosition(v+3u));
  var out:Output;out.position=u.vp*world;out.normal=normal;out.world=world.xyz;
  out.light=u.lightVP*vec4f(world.xyz+normal*.05,1);
  out.color=batchPosition(v+6u);out.kind=batchVertices[v+9u];
  let offsets=batchTexcoordOffsets[address>>16u];let textureInfo=batchTexcoords[offsets.x+(address&65535u)-offsets.y];out.uv=textureInfo.xy;out.sourceMaterial=u32(textureInfo.z);
  if(u.settings.y==0.0){let mat=materials[e.ids.y*2u];out.color=mix(out.color,mat.xyz,mat.w);let props=materials[e.ids.y*2u+1u];out.emission=mat.xyz*props.x;out.pbr=vec3f(props.y,props.z,mat.w);if(mat.w>.5){out.kind=0.0;}}
  return out;
}
@vertex fn shadowBatch(@builtin(vertex_index) address:u32)->ShadowOutput {
  let e=elements[address>>16u];let v=(address&65535u)*10u;
  var out:ShadowOutput;out.position=u.lightVP*e.m*vec4f(batchPosition(v),1);out.kind=select(batchVertices[v+9u],0.0,e.ids.y!=0u);return out;
}
