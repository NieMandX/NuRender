@group(0) @binding(0) var accumulation:texture_2d<f32>;
@group(0) @binding(1) var revealage:texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) id:u32)->@builtin(position) vec4f {
  let x=f32((id<<1u)&2u);let y=f32(id&2u);
  return vec4f(x*2-1,1-y*2,0,1);
}
@fragment fn fs(@builtin(position) position:vec4f)->@location(0) vec4f {
  let p=vec2i(position.xy);let reveal=textureLoad(revealage,p,0).r;
  if(reveal>=1){discard;}
  let sum=textureLoad(accumulation,p,0);
  return vec4f(sum.rgb/max(sum.a,.00001),1-reveal);
}
