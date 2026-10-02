struct Part { position: vec4f, size: vec4f, color: vec4f }
struct Building { origin: vec4f, color: vec4f }
@group(0) @binding(1) var<storage,read> parts: array<Part>;
@group(0) @binding(2) var<storage,read> buildings: array<Building>;
const STRUCTURED: bool = false;
struct VertexInput { @location(0) position: vec3f, @location(1) normal: vec3f, @builtin(instance_index) instance: u32 }
fn resolvePart(id: u32) -> Part {
  if (STRUCTURED) {
    let count = arrayLength(&parts);
    let b = buildings[id / count];
    var p = parts[id % count];
    p.color = select(p.color, b.color, p.position.w > 0.5);
    p.position = vec4f(p.position.xyz * vec3f(1,b.origin.w,1) + b.origin.xyz, 0);
    p.size = vec4f(p.size.xyz * vec3f(1,b.origin.w,1),0);
    return p;
  }
  return parts[id];
}
@vertex fn vs(input: VertexInput) -> Output {
  let p = resolvePart(input.instance);
  let world = input.position * p.size.xyz + p.position.xyz;
  var out: Output;
  out.position = u.vp * vec4f(world,1);
  out.normal = input.normal;
  out.color = p.color.xyz;
  out.world = world;
  out.light = u.lightVP * vec4f(world + input.normal * 0.05, 1);
  return out;
}
@vertex fn shadowVS(input: VertexInput) -> @builtin(position) @invariant vec4f {
  let p = resolvePart(input.instance);
  return u.lightVP * vec4f(input.position * p.size.xyz + p.position.xyz,1);
}
// C consumes a conventional baked building mesh with per-instance attributes.
struct MergedInput {
  @location(0) position: vec3f, @location(1) normal: vec3f,
  @location(2) color: vec4f, @location(3) origin: vec4f, @location(4) tint: vec4f
}
@vertex fn vsMerged(input: MergedInput) -> Output {
  let world = input.position * vec3f(1,input.origin.w,1) + input.origin.xyz;
  var out: Output;
  out.position = u.vp * vec4f(world,1);
  out.normal = input.normal;
  out.color = select(input.color.xyz, input.tint.xyz, input.color.w > 0.5);
  out.world = world;
  out.light = u.lightVP * vec4f(world + input.normal * 0.05,1);
  return out;
}
@vertex fn shadowMerged(input: MergedInput) -> @builtin(position) @invariant vec4f {
  return u.lightVP * vec4f(input.position * vec3f(1,input.origin.w,1) + input.origin.xyz,1);
}
