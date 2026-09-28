export type Vec3=[number,number,number];
export type Framing={target:readonly number[];radius:number};
export const CAMERA_FOV=.65;
const clamp=(value:number,lo:number,hi:number)=>Math.max(lo,Math.min(hi,value));

/** A movable orbit pivot; free look rotates the pivot around a stationary eye. */
export class NavigationCamera {
  yaw=.72;pitch=.68;distance=245;
  offset:Vec3=[0,0,0];
  fittedDistance(aspect:number){return this.distance*Math.max(1,1.2/Math.max(.01,aspect));}
  private arm(aspect:number):Vec3{
    const d=this.fittedDistance(aspect),c=Math.cos(this.pitch);
    return [Math.sin(this.yaw)*c*d,Math.sin(this.pitch)*d,Math.cos(this.yaw)*c*d];
  }
  pose(framing:Framing,aspect:number){
    const target=framing.target.map((v,i)=>v+this.offset[i]) as Vec3,arm=this.arm(aspect);
    return {target,eye:target.map((v,i)=>v+arm[i]) as Vec3};
  }
  orbit(dx:number,dy:number){this.yaw-=dx*.006;this.pitch=clamp(this.pitch+dy*.006,-Math.PI/2+.02,Math.PI/2-.02);}
  look(dx:number,dy:number,aspect:number){
    const before=this.arm(aspect);this.orbit(dx,dy);const after=this.arm(aspect);
    this.translate(before.map((v,i)=>v-after[i]));
  }
  private translate(delta:readonly number[]){for(let i=0;i<3;i++)this.offset[i]+=delta[i];}
  pan(dx:number,dy:number,width:number,height:number){
    const scale=2*this.fittedDistance(width/Math.max(1,height))*Math.tan(CAMERA_FOV/2)/Math.max(1,height);
    const s=Math.sin(this.yaw),c=Math.cos(this.yaw),sp=Math.sin(this.pitch),cp=Math.cos(this.pitch);
    // Screen-space drag: the scene follows the pointer in both axes.
    this.translate([(-c*dx-s*sp*dy)*scale,cp*dy*scale,(s*dx-c*sp*dy)*scale]);
  }
  zoom(factor:number,radius:number){
    if(!Number.isFinite(factor)||factor<=0)return;
    this.distance=clamp(this.distance*factor,Math.max(.5,radius*.001),Math.max(1400,radius*12));
  }
  fly(forward:number,right:number,up:number,seconds:number,radius:number,speed:number){
    const length=Math.hypot(forward,right,up);if(!length)return false;
    const step=Math.min(.05,Math.max(0,seconds))*Math.max(2,Math.min(this.distance*.3,radius*.25))*speed/length;
    const s=Math.sin(this.yaw),c=Math.cos(this.yaw);
    this.translate([(right*c-forward*s)*step,up*step,(-right*s-forward*c)*step]);return true;
  }
  resetOffset(){this.offset=[0,0,0];}
}
