import test from 'node:test';
import assert from 'node:assert/strict';
import {mat4} from 'wgpu-matrix';
import {NavigationCamera,CAMERA_FOV} from '../src/navigation-camera.ts';
import {NavigationControls} from '../src/navigation-controls.ts';
const framing={target:[23,9,-11],radius:200};
const close=(a:readonly number[],b:readonly number[],eps=1e-5)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<eps,`${a} != ${b}`));
const screen=(camera:NavigationCamera,point:number[],width:number,height:number)=>{
  const {eye,target}=camera.pose(framing,width/height);
  const m=mat4.multiply(mat4.perspective(CAMERA_FOV,width/height,.1,10000),mat4.lookAt(eye,target,[0,1,0]));
  const p=[...point,1],q=[0,1,2,3].map(r=>p.reduce((v,x,c)=>v+x*m[c*4+r],0));
  return [(q[0]/q[3]+1)*width/2,(1-q[1]/q[3])*height/2];
};
test('pan follows the pointer in screen pixels, including portrait framing',()=>{
  for(const [w,h] of [[1200,700],[390,844]]){
    const c=new NavigationCamera(),before=screen(c,framing.target,w,h),initial=c.pose(framing,w/h);
    c.pan(63,-29,w,h);
    const after=screen(c,framing.target,w,h),pose=c.pose(framing,w/h);
    close(after,[before[0]+63,before[1]-29],.001);
    close(pose.eye.map((v,i)=>v-initial.eye[i]),pose.target.map((v,i)=>v-initial.target[i]));
  }
});
test('free look preserves the eye; orbit preserves the pivot; reset restores it',()=>{
  const c=new NavigationCamera();c.pan(80,-12,1200,700);const eye=c.pose(framing,12/7).eye;
  c.look(140,50,12/7);close(c.pose(framing,12/7).eye,eye);
  const pivot=c.pose(framing,12/7).target;c.orbit(30,-20);close(c.pose(framing,12/7).target,pivot);
  c.resetOffset();close(c.pose(framing,12/7).target,framing.target);
});
test('flight is frame-rate independent, normalized diagonally and bounded after a stall',()=>{
  const run=(fps:number,f:number,r:number,u:number)=>{const c=new NavigationCamera();for(let i=0;i<fps;i++)c.fly(f,r,u,1/fps,200,1);return c;};
  const a=run(60,1,0,0),b=run(144,1,0,0),diagonal=run(60,1,1,1);
  close(a.offset,b.offset);assert.ok(Math.abs(Math.hypot(...a.offset)-Math.hypot(...diagonal.offset))<1e-7);
  const stalled=new NavigationCamera(),oneStep=new NavigationCamera();stalled.fly(1,0,0,60,200,1);oneStep.fly(1,0,0,.05,200,1);close(stalled.offset,oneStep.offset);
  close(run(60,0,0,1).offset,[0,50,0]);
});
test('camera stays finite at pitch and zoom limits, including invalid pinch data',()=>{
  const c=new NavigationCamera();c.orbit(1,1e8);assert.ok(c.pitch<Math.PI/2);c.orbit(1,-1e8);assert.ok(c.pitch>-Math.PI/2);
  c.zoom(1e-20,200);assert.equal(c.distance,.5);c.zoom(Infinity,200);assert.equal(c.distance,.5);c.zoom(-1,200);assert.equal(c.distance,.5);
  c.zoom(1e20,200);assert.equal(c.distance,2400);assert.ok(c.pose(framing,.5).eye.every(Number.isFinite));
});

// Exercise actual DOM event routing and release paths with EventTarget, without a GPU.
test('input focus, release, cancellation, modifiers and two-finger gestures',()=>{
  const oldWindow=Object.getOwnPropertyDescriptor(globalThis,'window'),oldDocument=Object.getOwnPropertyDescriptor(globalThis,'document');
  const win=new EventTarget(),doc=Object.assign(new EventTarget(),{hidden:false});
  Object.defineProperty(globalThis,'window',{configurable:true,value:win});Object.defineProperty(globalThis,'document',{configurable:true,value:doc});
  class Canvas extends EventTarget{
    clientWidth=1200;clientHeight=700;captures=new Set<number>();
    focus(){} blur(){this.dispatchEvent(new Event('blur'));}
    setPointerCapture(id:number){this.captures.add(id);}hasPointerCapture(id:number){return this.captures.has(id);}releasePointerCapture(id:number){this.captures.delete(id);}
  }
  const canvas=new Canvas(),camera=new NavigationCamera();let enabled=true,changes=0;
  const controls=new NavigationControls(canvas as unknown as HTMLCanvasElement,camera,()=>framing,()=>enabled,()=>changes++);
  const send=(target:EventTarget,type:string,props:Record<string,unknown>={})=>{const e=new Event(type,{cancelable:true});Object.assign(e,props);target.dispatchEvent(e);return e;};
  const down=(code:string,props:Record<string,unknown>={})=>send(canvas,'keydown',{code,shiftKey:false,ctrlKey:false,metaKey:false,altKey:false,isComposing:false,repeat:false,...props});
  const pointer=(type:string,id:number,x:number,y:number,button=0,pointerType='touch')=>send(canvas,type,{pointerId:id,clientX:x,clientY:y,button,pointerType});
  try{
    down('KeyD');send(win,'keyup',{code:'KeyD',shiftKey:false});assert.ok(Math.hypot(...camera.offset)>0,'short taps move even between render frames');camera.resetOffset();
    down('KeyW',{key:'ц'});assert.equal(controls.moving,true);controls.tick(performance.now()+30);assert.ok(Math.hypot(...camera.offset)>0);
    send(win,'keyup',{code:'KeyW',shiftKey:false});assert.equal(controls.moving,false);
    down('KeyW');send(win,'blur');assert.equal(controls.moving,false);
    down('KeyW');canvas.blur();assert.equal(controls.moving,false);
    down('KeyW');doc.hidden=true;send(doc,'visibilitychange');assert.equal(controls.moving,false);doc.hidden=false;
    down('KeyW',{metaKey:true});assert.equal(controls.moving,false);
    down('KeyW');down('Escape');assert.equal(controls.moving,false);
    down('KeyW');enabled=false;controls.tick(performance.now()+30);assert.equal(controls.moving,false);enabled=true;
    const before=[...camera.offset],angles=[camera.yaw,camera.pitch];
    pointer('pointerdown',1,100,100);pointer('pointerdown',2,200,100);pointer('pointermove',1,110,120);pointer('pointermove',2,210,120);
    close([camera.yaw,camera.pitch],angles);assert.notDeepEqual(camera.offset,before);assert.ok(Math.abs(camera.distance-245)<1e-7);
    pointer('pointercancel',1,110,120);controls.stop();assert.equal(canvas.captures.size,0);
    controls.wheelMode='trackpad';const distance=camera.distance,offset=[...camera.offset];
    send(canvas,'wheel',{deltaX:30,deltaY:20,deltaMode:0,ctrlKey:false});assert.equal(camera.distance,distance);assert.notDeepEqual(camera.offset,offset);
    send(canvas,'wheel',{deltaX:0,deltaY:-10,deltaMode:0,ctrlKey:true});assert.ok(camera.distance<distance);
    const count=changes;controls.destroy();down('KeyW');assert.equal(changes,count);assert.equal(controls.moving,false);
  }finally{
    controls.destroy();if(oldWindow)Object.defineProperty(globalThis,'window',oldWindow);else Reflect.deleteProperty(globalThis,'window');
    if(oldDocument)Object.defineProperty(globalThis,'document',oldDocument);else Reflect.deleteProperty(globalThis,'document');
  }
});
