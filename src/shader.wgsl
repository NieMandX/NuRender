struct Uniforms { vp: mat4x4f, lightVP: mat4x4f, camera: vec4f, settings: vec4f, lighting:vec4f }
struct Part { position: vec4f, size: vec4f, color: vec4f }
struct Building { origin: vec4f, color: vec4f }
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage,read> parts: array<Part>;
@group(0) @binding(2) var<storage,read> buildings: array<Building>;
@group(1) @binding(0) var shadow: texture_depth_2d;
@group(1) @binding(1) var shadowSampler: sampler_comparison;
@group(1) @binding(2) var hdrEnvironment:texture_2d<f32>;
@group(1) @binding(3) var hdrSampler:sampler;
@group(1) @binding(4) var<uniform> irradianceSH:array<vec4f,9>;
@group(1) @binding(5) var prefilteredEnvironment:texture_cube<f32>;
@group(1) @binding(6) var brdfLut:texture_2d<f32>;
@group(1) @binding(7) var prefilteredSampler:sampler;
override STRUCTURED: bool = false;
struct VertexInput { @location(0) position: vec3f, @location(1) normal: vec3f, @builtin(instance_index) instance: u32 }
struct Output { @builtin(position) @invariant position: vec4f, @location(0) normal: vec3f, @location(1) color: vec3f, @location(2) world: vec3f, @location(3) light: vec4f, @location(4) emission: vec3f, @location(5) pbr: vec3f, @location(6) @interpolate(flat) kind:f32, @location(7) uv:vec2f, @location(8) @interpolate(flat) sourceMaterial:u32 }
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
// GGX / Smith / Schlick metallic-roughness. Environment is procedural,
// sampled with 16 fixed GGX importance samples; diffuse is a sky approximation.
fn fresnel(c:f32,f0:vec3f)->vec3f{return f0+(vec3f(1)-f0)*pow(1-clamp(c,0,1),5);}
fn smith(n:f32,a2:f32)->f32{return 2*n/max(n+sqrt(a2+(1-a2)*n*n),0.00001);}
fn environmentDirection(d:vec3f)->vec3f {let c=cos(u.camera.w);let s=sin(u.camera.w);return vec3f(c*d.x-s*d.z,d.y,s*d.x+c*d.z);}
fn environment(d:vec3f,lod:f32)->vec3f {
  if(u.settings.w>0){let direction=environmentDirection(d);let uv=vec2f(atan2(direction.z,direction.x)/6.2831853+.5,acos(clamp(direction.y,-1,1))/3.14159265);return textureSampleLevel(hdrEnvironment,hdrSampler,uv,lod).rgb*u.settings.w;}
  let sky=mix(vec3f(.12,.10,.08),vec3f(.55,.72,1.0),smoothstep(-.15,.65,d.y));
  let panel=pow(max(dot(d,normalize(vec3f(-.6,.45,-.8))),0),32);
  let rim=pow(max(dot(d,normalize(vec3f(.9,.4,.3))),0),16);
  return sky+vec3f(3.0,2.7,2.2)*panel+vec3f(.5,.7,1.2)*rim;
}
fn environmentSpecular(n:vec3f,v:vec3f,rough:f32,f0:vec3f)->vec3f {
  if(u.lighting.x>.5&&u.settings.w>0){
    let nv=clamp(dot(n,v),0,1);let reflection=environmentDirection(reflect(-v,n));
    let radiance=textureSampleLevel(prefilteredEnvironment,prefilteredSampler,reflection,rough*8).rgb;
    let brdf=textureSampleLevel(brdfLut,prefilteredSampler,vec2f(nv,rough),0).rg;
    return radiance*(f0*brdf.x+vec3f(brdf.y));
  }
  let nv=max(dot(n,v),.0001);let a=rough*rough;let a2=a*a;
  let up=select(vec3f(0,1,0),vec3f(1,0,0),abs(n.y)>.99);
  let tangent=normalize(cross(up,n));let bitangent=cross(n,tangent);
  var sum=vec3f(0);
  for(var i=0u;i<16u;i++){
    let x=(f32(i)+.5)/16.0;let y=f32(reverseBits(i))*2.3283064365386963e-10;
    let phi=6.2831853*y;let ct=sqrt((1-x)/(1+(a2-1)*x));let st=sqrt(max(0,1-ct*ct));
    let h=normalize(tangent*(cos(phi)*st)+bitangent*(sin(phi)*st)+n*ct);
    let vh=max(dot(v,h),0);let l=2*vh*h-v;let nl=max(dot(n,l),0);
    if(nl>0&&vh>0){
      let denom=ct*ct*(a2-1)+1;let distribution=a2/max(3.14159265*denom*denom,.0000001);
      let pdf=max(distribution*ct/(4*vh),.000001);
      let texelSolidAngle=19.7392088*max(sqrt(max(0,1-l.y*l.y)),.001)/(1024.0*512.0);
      let lod=clamp(.5*log2(1.0/(16.0*pdf*texelSolidAngle)),0,10);
      sum+=environment(l,lod)*fresnel(vh,f0)*smith(nv,a2)*smith(nl,a2)*vh/max(ct*nv,.00001);}
  }
  return sum/16;
}
fn diffuseEnvironment(normal:vec3f)->vec3f {
  if(u.settings.w<=0){return mix(vec3f(.13,.11,.09),vec3f(.48,.6,.8),normal.y*.5+.5);}
  let n=environmentDirection(normal);let x=n.x;let y=n.y;let z=n.z;
  let basis=array<f32,9>(.2820947918,.4886025119*y,.4886025119*z,.4886025119*x,1.0925484306*x*y,1.0925484306*y*z,.3153915653*(3*z*z-1),1.0925484306*x*z,.5462742153*(x*x-y*y));
  var result=vec3f(0);for(var i=0u;i<9u;i++){result+=irradianceSH[i].rgb*basis[i];}return max(result,vec3f(0))*u.settings.w;
}
fn displayColor(linear:vec3f)->vec3f {
  let x=max(linear,vec3f(0));
  let mapped=clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),vec3f(0),vec3f(1));
  return select(1.055*pow(mapped,vec3f(1.0/2.4))-.055,12.92*mapped,mapped<=vec3f(.0031308));
}
struct SourceMaterial { props:vec4f, layers:vec4f, channels:vec4f, transforms:array<vec4f,8> }
@group(3) @binding(0) var sourceImages:texture_2d_array<f32>;
@group(3) @binding(1) var sourceSampler:sampler;
@group(3) @binding(2) var<storage,read> sourceMaterials:array<SourceMaterial>;
struct Derivatives { uvX:vec2f, uvY:vec2f, worldX:vec3f, worldY:vec3f }
fn derivatives(input:Output)->Derivatives {return Derivatives(dpdx(input.uv),dpdy(input.uv),dpdx(input.world),dpdy(input.world));}
fn sampleMap(material:SourceMaterial,role:u32,uv:vec2f,d:Derivatives)->vec4f {
  let a=material.transforms[role*2u];let b=material.transforms[role*2u+1u];
  let mapped=vec2f(dot(a.xy,uv)+a.z,1.0-dot(b.xy,uv)-b.z);
  let dx=vec2f(dot(a.xy,d.uvX),-dot(b.xy,d.uvX));let dy=vec2f(dot(a.xy,d.uvY),-dot(b.xy,d.uvY));
  return textureSampleGrad(sourceImages,sourceSampler,mapped,i32(material.layers[role]),dx,dy);
}
fn linearColor(c:vec3f)->vec3f {return select(pow((c+.055)/1.055,vec3f(2.4)),c/12.92,c<=vec3f(.04045));}
struct Surface { normal:vec3f,base:vec3f,rough:f32,metal:f32 }
fn surface(input:Output,front:bool,d:Derivatives)->Surface {
  let stemolit=input.kind==2||input.kind==4;
  var out:Surface;
  out.normal=normalize(select(-input.normal,input.normal,front));
  out.base=select(clamp(input.color,vec3f(0),vec3f(1)),vec3f(.72,.74,.77),stemolit);
  out.rough=select(select(.7,.3,input.kind==3),.08,input.kind==1||stemolit);
  out.metal=select(0.0,1.0,input.kind==3);
  if(input.pbr.z>.5){out.rough=input.pbr.x;out.metal=input.pbr.y;}
  else if(u.settings.z>0&&input.sourceMaterial>0u&&!stemolit){
    let material=sourceMaterials[input.sourceMaterial];
    if(material.layers.x>=0){let color=sampleMap(material,0u,input.uv,d).rgb;out.base=select(color,linearColor(color),material.channels.z>.5);}
    if(u.settings.z>1){
      out.rough=material.props.x;out.metal=material.props.y;
      if(material.layers.y>=0){out.rough=sampleMap(material,1u,input.uv,d)[u32(material.channels.x)];}
      if(material.layers.z>=0){out.metal=sampleMap(material,2u,input.uv,d)[u32(material.channels.y)];}
      if(input.kind==3){out.metal=1;}
      if(input.kind==1){out.rough=.08;out.metal=0;}
      if(material.layers.w>=0){
        // Blender's Normal Map uses the untransformed UV layer for its tangent frame.
        let determinant=d.uvX.x*d.uvY.y-d.uvX.y*d.uvY.x;
        let tangentRaw=d.worldX*d.uvY.y-d.worldY*d.uvX.y;
        let projected=tangentRaw-out.normal*dot(out.normal,tangentRaw);
        if(abs(determinant)>.0000000001&&dot(projected,projected)>.0000000001){
          let tangent=normalize(projected)*sign(determinant);
          let bitangentRaw=(d.worldY*d.uvX.x-d.worldX*d.uvY.x)*sign(determinant);
          let bitangent=cross(out.normal,tangent)*sign(dot(cross(out.normal,tangent),bitangentRaw));
          var normal=sampleMap(material,3u,input.uv,d).xyz*2-1;
          normal=normalize(vec3f(normal.xy*material.props.z,normal.z));
          out.normal=normalize(tangent*normal.x+bitangent*normal.y+out.normal*normal.z);
        }
      }
    }
  }
  out.rough=clamp(out.rough,.05,1);out.metal=clamp(out.metal,0,1);return out;
}
fn shade(input:Output,front:bool,deriv:Derivatives)->vec3f {
  let material=surface(input,front,deriv);let n=material.normal;
  let v=normalize(u.camera.xyz-input.world);let l=normalize(vec3f(-.6,1,.4));let h=normalize(v+l);
  let nl=max(dot(n,l),0);let nv=max(dot(n,v),.0001);let nh=max(dot(n,h),0);let vh=max(dot(v,h),0);
  let projected=input.light.xyz/input.light.w;let uv=projected.xy*vec2f(.5,-.5)+.5;
  var visibility=0.0;
  for(var x=-1;x<=1;x++){for(var y=-1;y<=1;y++){visibility+=textureSampleCompareLevel(shadow,shadowSampler,uv+vec2f(f32(x),f32(y))/2048,projected.z-.0006);}}
  visibility/=9;
  if(u.settings.y!=0){return input.color*(.4+.6*nl*visibility);}
  let rough=material.rough;let metal=material.metal;let base=material.base;
  let diffuseWeight=select(1.0,0.0,input.kind==1);
  let f0=mix(vec3f(.04),base,metal);let f=fresnel(vh,f0);
  let a=rough*rough;let a2=a*a;let denom=nh*nh*(a2-1)+1;
  let d=a2/max(3.14159265*denom*denom,.0000001);
  let spec=d*smith(nv,a2)*smith(nl,a2)*f/max(4*nv*nl,.00001);
  let diffuse=(vec3f(1)-f)*(1-metal)*base*diffuseWeight/3.14159265;
  let direct=(diffuse+spec)*vec3f(2.6,2.45,2.2)*nl*visibility;
  let diffuseSky=diffuseEnvironment(n);
  let indirect=(vec3f(1)-fresnel(nv,f0))*(1-metal)*base*diffuseSky*diffuseWeight+environmentSpecular(n,v,rough,f0);
  return direct+indirect+input.emission;
}
@fragment fn fs(input:Output,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let deriv=derivatives(input);
  if(input.kind==1&&u.settings.y==0){discard;}
  return vec4f(displayColor(shade(input,front,deriv)),1);
}
// Weighted blended transparency. No refraction or coloured transmission.
struct TransparentOutput { @location(0) accumulation:vec4f, @location(1) revealage:f32 }
@fragment fn fsTransparent(input:Output,@builtin(front_facing) front:bool)->TransparentOutput {
  let deriv=derivatives(input);
  if(input.kind!=1||u.settings.y!=0){discard;}
  let n=normalize(select(-input.normal,input.normal,front));let v=normalize(u.camera.xyz-input.world);
  let a=.12+.88*fresnel(abs(dot(n,v)),vec3f(.04)).x;
  let weight=clamp(10.0/(.1+length(u.camera.xyz-input.world)*.01),.1,10.0);
  var out:TransparentOutput;
  // Weighted OIT accumulates premultiplied colour and alpha with the same weight.
  out.accumulation=vec4f(displayColor(shade(input,front,deriv))*a,a)*weight;
  out.revealage=a;return out;
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
struct ShadowOutput { @builtin(position) @invariant position:vec4f, @location(0) @interpolate(flat) kind:f32 }
@vertex fn shadowReal(input:RealInput)->ShadowOutput {
  var out:ShadowOutput;out.position=u.lightVP*mat4x4f(input.m0,input.m1,input.m2,input.m3)*vec4f(input.position,1);out.kind=input.color.w;return out;
}
@fragment fn shadowMask(input:ShadowOutput) { if(input.kind==1&&u.settings.y==0){discard;} }

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
