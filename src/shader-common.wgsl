struct Uniforms { vp: mat4x4f, lightVP: mat4x4f, camera: vec4f, settings: vec4f, lighting:vec4f }
@group(0) @binding(0) var<uniform> u: Uniforms;
struct Output { @builtin(position) @invariant position: vec4f, @location(0) normal: vec3f, @location(1) color: vec3f, @location(2) world: vec3f, @location(3) light: vec4f, @location(4) emission: vec3f, @location(5) pbr: vec3f, @location(6) @interpolate(flat) kind:f32, @location(7) uv:vec2f, @location(8) @interpolate(flat) sourceMaterial:u32 }
struct ShadowOutput { @builtin(position) @invariant position:vec4f, @location(0) @interpolate(flat) kind:f32 }
