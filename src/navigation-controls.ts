import {NavigationCamera,type Framing} from './navigation-camera';
export type WheelMode='mouse'|'trackpad';
type Point={x:number;y:number;type:string;button:number};
const moveKeys=new Set(['KeyW','KeyA','KeyS','KeyD','KeyQ','KeyE']);
export class NavigationControls {
  wheelMode:WheelMode;
  speed=1;
  private pointers=new Map<number,Point>();
  private keys=new Set<string>();
  private shift=false;private lastTime=0;private gestureScale:number|null=null;
  private listeners=new AbortController();
  constructor(private canvas:HTMLCanvasElement,private camera:NavigationCamera,
    private framing:()=>Framing,private enabled:()=>boolean,private changed:()=>void){
    this.wheelMode=/Mac|iPhone|iPad|iPod/.test(navigator.platform||navigator.userAgent)?'trackpad':'mouse';
    const signal=this.listeners.signal;
    canvas.addEventListener('pointerdown',e=>{
      if(!this.enabled()||(e.pointerType!=='touch'&&![0,1,2].includes(e.button)))return;
      e.preventDefault();canvas.focus({preventScroll:true});
      this.pointers.set(e.pointerId,{x:e.clientX,y:e.clientY,type:e.pointerType,button:e.button});canvas.setPointerCapture(e.pointerId);
    },{signal});
    canvas.addEventListener('pointermove',e=>{
      const old=this.pointers.get(e.pointerId);if(!old)return;
      if(!this.enabled()){this.stop();return;}
      const before=this.touchPair();this.pointers.set(e.pointerId,{...old,x:e.clientX,y:e.clientY});const after=this.touchPair();
      if(before&&after){
        this.camera.pan(after.x-before.x,after.y-before.y,canvas.clientWidth,canvas.clientHeight);
        if(before.distance>1&&after.distance>1)this.camera.zoom(before.distance/after.distance,this.framing().radius);
      }else if(this.pointers.size===1){
        const dx=e.clientX-old.x,dy=e.clientY-old.y;
        // A two-finger trackpad click is reported as the secondary mouse button.
        if(old.button===1||(old.button===2&&this.wheelMode==='trackpad')||(old.button===0&&e.shiftKey))this.camera.pan(dx,dy,canvas.clientWidth,canvas.clientHeight);
        else if(old.button===2)this.camera.look(dx,dy,canvas.clientWidth/Math.max(1,canvas.clientHeight));
        else this.camera.orbit(dx,dy);
      }else return;
      this.changed();
    },{signal});
    for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,e=>{
      const id=(e as PointerEvent).pointerId;this.pointers.delete(id);if(canvas.hasPointerCapture(id))canvas.releasePointerCapture(id);
    },{signal});
    canvas.addEventListener('contextmenu',e=>e.preventDefault(),{signal});
    canvas.addEventListener('auxclick',e=>{if(e.button===1)e.preventDefault();},{signal});
    canvas.addEventListener('wheel',e=>{
      if(!this.enabled())return;e.preventDefault();
      if(this.gestureScale!==null)return;
      const unit=e.deltaMode===1?16:e.deltaMode===2?canvas.clientHeight:1,dx=e.deltaX*unit,dy=e.deltaY*unit;
      if(e.ctrlKey||!e.shiftKey)this.camera.zoom(Math.exp(Math.max(-2,Math.min(2,dy*(e.ctrlKey ? .01 : .001)))),this.framing().radius);
      else this.camera.pan(-dx,-dy,canvas.clientWidth,canvas.clientHeight);
      this.changed();
    },{signal,passive:false});
    // Safari trackpad pinch. Touch pointers already implement pinch on the canvas.
    canvas.addEventListener('gesturestart',e=>{
      if(!this.enabled())return;e.preventDefault();if(!this.touchPair())this.gestureScale=1;
    },{signal,passive:false});
    canvas.addEventListener('gesturechange',e=>{
      if(!this.enabled())return;e.preventDefault();if(this.gestureScale===null)return;
      const scale=(e as Event&{scale:number}).scale;
      if(Number.isFinite(scale)&&scale>0){this.camera.zoom(this.gestureScale/scale,this.framing().radius);this.gestureScale=scale;this.changed();}
    },{signal,passive:false});
    canvas.addEventListener('gestureend',()=>{this.gestureScale=null;},{signal});
    canvas.addEventListener('keydown',e=>{
      if(e.code==='Escape'){this.stop();canvas.blur();return;}
      if(e.ctrlKey||e.metaKey||e.altKey){this.stop();return;}
      if(!this.enabled()||e.isComposing)return;
      this.shift=e.shiftKey;
      if(!moveKeys.has(e.code))return;e.preventDefault();
      if(e.repeat)return;
      if(!this.moving)this.lastTime=performance.now();this.keys.add(e.code);this.changed();
    },{signal});
    window.addEventListener('keyup',e=>{
      const wasMoving=this.keys.has(e.code);
      // Account for a short tap that begins and ends between two animation frames.
      if(wasMoving)this.tick(performance.now());
      this.shift=e.shiftKey;this.keys.delete(e.code);if(wasMoving)this.changed();
    },{signal});
    canvas.addEventListener('blur',()=>this.stop(),{signal});
    window.addEventListener('blur',()=>this.stop(),{signal});
    document.addEventListener('visibilitychange',()=>{if(document.hidden)this.stop();},{signal});
  }
  private touchPair(){
    const p=[...this.pointers.values()];if(p.length!==2||p.some(v=>v.type!=='touch'))return null;
    return {x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2,distance:Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y)};
  }
  get moving(){return this.keys.size>0;}
  tick(time:number){
    if(!this.enabled()){this.stop();return;}
    if(!this.moving)return;
    const pressed=(code:string)=>Number(this.keys.has(code));
    this.camera.fly(pressed('KeyW')-pressed('KeyS'),pressed('KeyD')-pressed('KeyA'),pressed('KeyE')-pressed('KeyQ'),(time-this.lastTime)/1000,this.framing().radius,this.speed*(this.shift?4:1));
    this.lastTime=time;
  }
  stop(){
    this.keys.clear();this.shift=false;this.gestureScale=null;
    const ids=[...this.pointers.keys()];this.pointers.clear();
    for(const id of ids)if(this.canvas.hasPointerCapture(id))this.canvas.releasePointerCapture(id);
  }
  destroy(){this.stop();this.listeners.abort();}
}
