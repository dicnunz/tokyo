import * as THREE from 'three';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';
import {InteriorWorld,insideBox,findFloorLanding,type InteriorManifest,type RoomInteraction} from './interior-world';
import {FrameMonitor} from './performance';
import {streetReturnURL} from './street-return';
import './interior.css';

const canvas=document.querySelector<HTMLCanvasElement>('#interior')!,status=document.querySelector<HTMLElement>('#status')!,loading=document.querySelector<HTMLElement>('#loading')!,prompt=document.querySelector<HTMLButtonElement>('#interaction')!;
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});renderer.setPixelRatio(Math.min(devicePixelRatio,1.25));renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.NeutralToneMapping;renderer.toneMappingExposure=1;
renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;renderer.shadowMap.autoUpdate=false;renderer.shadowMap.needsUpdate=true;
const scene=new THREE.Scene();scene.background=new THREE.Color('#c7dee9');
const pmrem=new THREE.PMREMGenerator(renderer),environment=new RoomEnvironment(),environmentMap=pmrem.fromScene(environment,.04, .1,100);scene.environment=environmentMap.texture;scene.environmentIntensity=.65;pmrem.dispose();environment.dispose();
const sky=new THREE.HemisphereLight(0xf2f8ff,0x858475,1.15);scene.add(sky);
const sun=new THREE.DirectionalLight(0xffebd0,3.2);sun.position.set(-7,9,8);sun.target.position.set(0,0,-3);sun.castShadow=true;sun.shadow.mapSize.set(2048,2048);sun.shadow.camera.left=-12;sun.shadow.camera.right=12;sun.shadow.camera.top=12;sun.shadow.camera.bottom=-12;sun.shadow.camera.near=.5;sun.shadow.camera.far=35;sun.shadow.bias=-.00015;sun.shadow.normalBias=.025;scene.add(sun,sun.target);
const warm=new THREE.HemisphereLight(0xffdfb1,0x574b3c,.85);scene.add(warm);
const camera=new THREE.PerspectiveCamera(65,innerWidth/innerHeight,.04,150);camera.rotation.order='YXZ';
const position=new THREE.Vector3(0,1.7,4),next=new THREE.Vector3(),direction=new THREE.Vector3();let yaw=0,pitch=-.035,fly=false,paused=false,dragging=false,world:InteriorWorld|undefined,currentInteraction:RoomInteraction|undefined,atExit=false,loaded=false,lost=false;
const keys=new Set<string>();let last=performance.now(),lastStatus=0,distance=0;
const monitor=new FrameMonitor(renderer,()=>{}),back=document.querySelector<HTMLAnchorElement>('#back')!;back.href=streetReturnURL();
function clearKeys(){keys.clear();dragging=false;}
function performInteraction(){if(!loaded||!world)return;if(currentInteraction)world.interact(currentInteraction);else if(atExit)location.href=back.href;}
prompt.addEventListener('click',performInteraction);
function mode(){if(fly&&world){const landing=findFloorLanding(position,world.spec.bounds,point=>world!.blocked(point));if(!landing)return;position.copy(landing);}fly=!fly;paused=false;document.querySelector('#mode')!.textContent=fly?'Walk · F':'Fly · F';}
document.querySelector('#mode')!.addEventListener('click',mode);
canvas.addEventListener('pointerdown',event=>{if(event.button!==0)return;dragging=true;paused=false;canvas.setPointerCapture(event.pointerId);});
canvas.addEventListener('pointerup',event=>{dragging=false;if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);});
canvas.addEventListener('pointermove',event=>{if(!dragging&&document.pointerLockElement!==canvas)return;yaw-=event.movementX*.002;pitch=THREE.MathUtils.clamp(pitch-event.movementY*.002,-1.45,1.45);});
canvas.addEventListener('dblclick',()=>{paused=false;canvas.requestPointerLock()?.catch(()=>{});});
document.addEventListener('pointerlockchange',clearKeys);window.addEventListener('blur',clearKeys);
document.addEventListener('keydown',event=>{
 if((event.target as HTMLElement).matches('input,select')||document.querySelector('dialog[open]'))return;
 if(event.code==='Escape'){paused=true;clearKeys();return;}
 if(event.code==='KeyF'&&!event.repeat){mode();return;}
 if(event.code==='KeyE'&&!fly&&!event.repeat){performInteraction();event.preventDefault();return;}
 if(['KeyW','KeyA','KeyS','KeyD','KeyE','KeyQ','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','ShiftLeft','ShiftRight'].includes(event.code)){keys.add(event.code);paused=false;event.preventDefault();}
});document.addEventListener('keyup',event=>keys.delete(event.code));
const about=document.querySelector<HTMLDialogElement>('#about-dialog')!;document.querySelector('#about')!.addEventListener('click',()=>{document.exitPointerLock();clearKeys();about.showModal();});document.querySelector('#close-about')!.addEventListener('click',()=>about.close());
window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();lost=true;clearKeys();loading.hidden=false;loading.textContent='Restoring this room…';monitor.contextLost();});
canvas.addEventListener('webglcontextrestored',()=>{location.reload();});
const pressed=(...codes:string[])=>codes.some(code=>keys.has(code));
let audit:{started:number;duration:number;frames:number[];distance:number;heading:number}|null=null,auditResult:unknown=null;
function tick(now:number){
 requestAnimationFrame(tick);const elapsed=now-last,dt=Math.min(.035,elapsed/1000);last=now;if(document.hidden||lost){clearKeys();monitor.resetClock();return;}monitor.begin(now);
 if(loaded&&world){
  if(!paused&&!about.open){
   let forward=(pressed('KeyW','ArrowUp')?1:0)-(pressed('KeyS','ArrowDown')?1:0),side=(pressed('KeyD','ArrowRight')?1:0)-(pressed('KeyA','ArrowLeft')?1:0);
   if(audit){const phase=((now-audit.started)/1000)%12;forward=phase<6?1:-1;side=0;yaw=audit.heading;}
   const length=Math.hypot(side,forward);if(length>1){side/=length;forward/=length;}
   const speed=(pressed('ShiftLeft','ShiftRight')?2.8:1.4)*(fly?1.4:1),dx=(Math.cos(yaw)*side-Math.sin(yaw)*forward)*speed*dt,dz=(-Math.sin(yaw)*side-Math.cos(yaw)*forward)*speed*dt;
   const move=(x:number,z:number)=>{next.set(x,position.y,z);if(!insideBox(next,world!.spec.bounds,-.02)||world!.blocked(next))return;distance+=next.distanceTo(position);position.copy(next);};
   if(dx)move(position.x+dx,position.z);if(dz)move(position.x,position.z+dz);
   if(fly){const up=(pressed('KeyE','Space')?1:0)-(pressed('KeyQ')?1:0);next.copy(position);next.y=THREE.MathUtils.clamp(position.y+up*speed*dt,1.7,world.spec.bounds.max[1]-.2);if(!world.blocked(next))position.copy(next);}else position.y=1.7;
  }
  world.update(dt);camera.position.copy(position);camera.rotation.set(pitch,yaw,0);camera.getWorldDirection(direction);currentInteraction=world.nearest(position,direction);atExit=insideBox(position,world.spec.exitBox,.45);
  prompt.hidden=!currentInteraction&&!atExit;if(!prompt.hidden)prompt.textContent=(fly?'Click  ':'E  ')+(currentInteraction?world.label(currentInteraction):'Return to the street');
 }
 monitor.beforeRender();renderer.render(scene,camera);monitor.end();
 if(audit){audit.frames.push(elapsed);if(now-audit.started>=audit.duration){const times=audit.frames.slice().sort((a,b)=>a-b);auditResult={metres:distance-audit.distance,samples:times.length,meanMs:times.reduce((a,b)=>a+b,0)/times.length,p95Ms:times[Math.floor(times.length*.95)],maxMs:times.at(-1),hitches50:times.filter(value=>value>50).length,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,pixelRatio:renderer.getPixelRatio()};audit=null;paused=true;}}
 if(now-lastStatus>400){lastStatus=now;status.textContent=loaded?`${monitor.stats.fps} fps · ${fly?'FLIGHT':'WALK'}`:'Preparing the room';}
}
requestAnimationFrame(tick);
async function load(){
 const url=new URL('/interiors/shibuya/manifest.json',location.href).href,response=await fetch(url);if(!response.ok)throw Error('The furnished room is being prepared.');
 const manifest:InteriorManifest=await response.json(),id=new URLSearchParams(location.search).get('space')??'cafe',spec=manifest.spaces.find(item=>item.id===id)??manifest.spaces[0];if(!spec)throw Error('The interior manifest has no rooms.');
 document.title=spec.title+' · Tokyo';document.querySelector('#title')!.textContent=spec.title;canvas.setAttribute('aria-label',`Walkable furnished ${spec.title}`);
 world=new InteriorWorld(spec,renderer,[warm]);await world.load(url);scene.add(world.group);position.fromArray(spec.spawn);camera.position.copy(position);camera.rotation.set(pitch,yaw,0);camera.updateMatrixWorld();
 await renderer.compileAsync(scene,camera);renderer.shadowMap.needsUpdate=true;renderer.render(scene,camera);loaded=true;loading.hidden=true;monitor.reset();
}
void load().catch(error=>{loading.hidden=false;loading.textContent=String((error as Error).message||error);});
Object.defineProperty(window,'tokyoInterior',{value:{get diagnostics(){return{loaded,space:world?.spec.id,position:position.toArray(),yaw,pitch,fly,distance,interaction:currentInteraction?.id,atExit,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,performance:monitor.stats,error:loaded?'':loading.textContent};},get spec(){return world?.spec;},beginWalkCheck:(seconds=24,heading=0)=>{if(!loaded)throw Error('Room is loading');auditResult=null;paused=false;fly=false;audit={started:performance.now(),duration:seconds*1000,frames:[],distance,heading};monitor.reset();},get motionCheck(){return{running:!!audit,result:auditResult};}}});
window.addEventListener('pagehide',()=>{world?.dispose();environmentMap.dispose();renderer.dispose();});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
