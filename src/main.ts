import * as THREE from 'three';
import {GeoFrame} from './geo';
import {Terrain} from './terrain';
import {GroundImagery} from './ground-imagery';
import {Buildings} from './buildings';
import {FlightMotion} from './flight-motion';
import {Neighborhood} from './neighborhood';
import {DistrictDetails} from './district-details';
import {readStreetReturn} from './street-return';
import {FrameMonitor} from './performance';
import {setupMap,PLACES} from './map';
import './style.css';
performance.setResourceTimingBufferSize(5000);
import {exportCity} from './studio-export';
import {CinematicRenderer} from './cinematic-renderer';
import {CinemaFlight} from './cinema-flight';
const canvas=document.querySelector<HTMLCanvasElement>('#world')!,status=document.querySelector('#status')!,coordinates=document.querySelector('#coordinates')!,place=document.querySelector('#place')!,notice=document.querySelector<HTMLDivElement>('#notice')!;
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,reversedDepthBuffer:true,powerPreference:'high-performance'});renderer.setPixelRatio(Math.min(devicePixelRatio,1));renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.25;
const scene=new THREE.Scene();scene.matrixAutoUpdate=false;scene.updateMatrix();scene.background=new THREE.Color('#dce7e2');scene.fog=new THREE.Fog('#dce7e2',300,530);scene.add(new THREE.HemisphereLight(0xf9fbf1,0x747b65,2.7));const sun=new THREE.DirectionalLight(0xfff2d8,2.5);sun.position.set(-400,600,200);scene.add(sun);
const camera=new THREE.PerspectiveCamera(65,innerWidth/innerHeight,.25,1800);camera.rotation.order='YXZ';
const visual=new CinematicRenderer(renderer,scene,camera);
const cinema=new CinemaFlight(camera,renderer,visual);
const land=new THREE.Group(),city=new THREE.Group();scene.add(land,city);
let frame=new GeoFrame(35.6595,139.7005),terrain:Terrain|undefined,buildings:Buildings|undefined;
let imagery:GroundImagery|undefined,district:DistrictDetails|undefined;
let active=false,paused=false,fly=false,yaw=-.7,pitch=-.08,vertical=0,grounded=false,enterPending=false,transition=0,ready=false,worldError='',travelled=0;const player=new THREE.Vector3(0,100,0),keys=new Set<string>(),tapUntil=new Map<string,number>();
const flightMotion=new FlightMotion();
let arrivalFacing:{yaw:number;pitch:number}|null=null;
type GraphicsRecovery={lat:number;lon:number;height:number;ellipsoidHeight?:number;name:string;active:boolean;paused:boolean;fly:boolean;yaw:number;pitch:number;transition:number;reason?:'rebase'};
type PhysicalPosition=ReturnType<GeoFrame['toGeo']>&{ellipsoidHeight:number};
let graphicsLost=false,graphicsRecovery:GraphicsRecovery|null=null;
let rebaseCount=0,lastRebase:{before:PhysicalPosition;after:PhysicalPosition|null}|null=null;
const pressed=(code:string)=>keys.has(code)||(tapUntil.get(code)||0)>performance.now();
function say(message:string){notice.textContent=message;notice.style.display='block';setTimeout(()=>notice.style.display='none',4200);}
function restorePose(recovery:GraphicsRecovery){
 const height=recovery.ellipsoidHeight===undefined?recovery.height:recovery.ellipsoidHeight-frame.elevationOffset;
 active=recovery.active;fly=recovery.fly;yaw=recovery.yaw;pitch=recovery.pitch;
 player.copy(frame.toLocal(recovery.lat,recovery.lon,height));camera.position.copy(player);camera.rotation.set(pitch,yaw,0);
}
async function travel(lat:number,lon:number,name:string,rebase=false,restoring=false){
 if(graphicsLost){const current=frame.toGeo(player.x,player.y,player.z);graphicsRecovery={lat,lon,height:rebase?current.height:100,ellipsoidHeight:rebase?current.height+frame.elevationOffset:undefined,name,active,paused:graphicsRecovery?.paused??paused,fly,yaw:rebase?yaw:-.7,pitch:rebase?pitch:active?-.05:-.48,transition:-1};place.textContent=name;return;}
 if(!restoring){
  graphicsRecovery=null;
  if(rebase){const position=frame.toGeo(player.x,player.y,player.z),ellipsoidHeight=position.height+frame.elevationOffset;
   graphicsRecovery={...position,ellipsoidHeight,name,active,paused,fly,yaw,pitch,transition:-1,reason:'rebase'};
   rebaseCount++;lastRebase={before:{...position,ellipsoidHeight},after:null};
  }
 }
 const recovery=rebase?graphicsRecovery:null;
 neighborhood.clear();resetSettle();const id=++transition;if(recovery){recovery.transition=id;paused=true;}else if(!rebase)paused=false;
 ready=false;worldError='';enterPending=active&&(!rebase||!fly);district?.dispose();district=undefined;buildings?.dispose();terrain?.dispose();imagery?.dispose();imagery=undefined;buildings=undefined;terrain=undefined;place.textContent=name;status.textContent='Aligning survey elevations…';frame=new GeoFrame(lat,lon);
 // The frame changes its origin, never the player's physical height or mode.
 if(recovery)restorePose(recovery);else player.set(0,100,0);
 vertical=0;flightMotion.reset();try{const r=await fetch(`/api/geoid?lat=${lat}&lon=${lon}`);const j=await r.json();const h=Number(j.OutputData?.geoidHeight);if(!r.ok||!Number.isFinite(h))throw Error('Elevation alignment unavailable. Please retry this destination.');if(id!==transition)return;frame.elevationOffset=h;
 imagery=new GroundImagery(frame,renderer);terrain=new Terrain(frame,land,renderer,imagery);buildings=new Buildings(frame,city,camera,renderer,imagery);terrain.setRoadSurfaceProvider((x,z)=>buildings?.sampleGroundRoad(x,z)??null);buildings.onGroundRoadBoundsChanged=(minX,minZ,maxX,maxZ)=>terrain?.invalidateRoadBounds(minX,minZ,maxX,maxZ);
 if(Math.abs(lat-35.6602)<.015&&Math.abs(lon-139.6992)<.02)district=new DistrictDetails(frame,scene,renderer,terrain,imagery);
 if(recovery){restorePose(recovery);enterPending=active&&!fly;paused=true;if(recovery.reason==='rebase'&&lastRebase){const position=frame.toGeo(player.x,player.y,player.z);lastRebase.after={...position,ellipsoidHeight:position.height+frame.elevationOffset};}}
 else{player.y=h+100;yaw=-.7;pitch=active?-.05:-.48;}
 ready=true;const u=new URL(location.href);u.searchParams.set('lat',lat.toFixed(6));u.searchParams.set('lon',lon.toFixed(6));history.replaceState(null,'',u);
 }catch(e){if(id===transition){if(recovery&&graphicsRecovery===recovery){graphicsRecovery=null;paused=recovery.paused;}worldError=String((e as Error).message);status.textContent=worldError;say(worldError);}}}
function toggleFly(){if(graphicsLost||graphicsRecovery)return;resetSettle();cinema.stop();buildings?.clearPreloadPoints();terrain?.setPreloadPoints([]);preparedTransition=-1;active=true;paused=false;fly=!fly;vertical=0;flightMotion.reset();enterPending=!fly;document.body.classList.add('walking');document.querySelector('#fly-mode')!.textContent=fly?'Land · F':'Fly · F';say(fly?'Flight · WASD steer · E / Q altitude · Shift faster':'Finding a clear place to land…');}
document.querySelector('#fly-mode')!.addEventListener('click',toggleFly);
function start(){if(graphicsLost||graphicsRecovery)return;resetSettle();active=true;paused=false;fly=false;enterPending=true;document.body.classList.add('walking');pitch=-.04;canvas.requestPointerLock()?.catch(()=>say('Drag to look · WASD to walk'));}
document.querySelector('#enter')!.addEventListener('click',start);canvas.addEventListener('click',()=>{if(graphicsLost||graphicsRecovery)return;if(!active)start();else {paused=false;canvas.requestPointerLock()?.catch(()=>say('Drag to look · WASD to walk'));}});
document.addEventListener('mousemove',e=>{if(document.pointerLockElement!==canvas&&!(active&&!paused&&e.buttons===1&&e.target===canvas))return;yaw-=e.movementX*.002;pitch=Math.max(-1.5,Math.min(1.5,pitch-e.movementY*.002));});
document.addEventListener('pointerlockchange',()=>{keys.clear();tapUntil.clear();if(active&&document.pointerLockElement!==canvas)say('Drag to look · WASD walk · M opens the map');});
window.addEventListener('blur',()=>{keys.clear();tapUntil.clear();});
const map=setupMap((lat,lon,name)=>{active=true;document.body.classList.add('walking');fly=false;void travel(lat,lon,name);},()=>frame.toGeo(player.x,player.y,player.z));
const neighborhood=new Neighborhood(async destination=>{active=true;fly=false;document.body.classList.add('walking');await travel(destination.lat,destination.lon,destination.title);arrivalFacing={yaw:destination.yaw,pitch:-.035};});
void neighborhood.load().catch(error=>{document.querySelector('#spaces')!.textContent=String(error.message||error);});
const about=document.querySelector<HTMLDialogElement>('#about-dialog')!;document.querySelector('#about-button')!.addEventListener('click',()=>{document.exitPointerLock();about.showModal();});document.querySelector('#close-about')!.addEventListener('click',()=>about.close());
document.addEventListener('keydown',e=>{if((e.target as HTMLElement).matches('input'))return;if(e.code==='Escape'){cinema.stop();paused=true;if(graphicsRecovery)graphicsRecovery.paused=true;keys.clear();tapUntil.clear();return;}if(e.code==='KeyM'&&!e.repeat){map.open();return;}if(document.querySelector('dialog[open]'))return;if(e.code==='KeyE'&&!fly&&!e.repeat&&neighborhood.enter()){e.preventDefault();return;}keys.add(e.code);tapUntil.set(e.code,performance.now()+85);if(['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code))e.preventDefault();if(e.code==='KeyF'&&!e.repeat&&active){toggleFly();}if(e.code==='Space'&&grounded&&!fly){vertical=4;grounded=false;}});document.addEventListener('keyup',e=>keys.delete(e.code));
let settleTask:Generator<void,boolean>|undefined,settleRetryAt=0,settleLastFrame=-1;
const settleTiming={slices:0,searches:0,completed:0,failed:0,totalMs:0,maxSliceMs:0};
function resetSettle(){settleTask=undefined;settleRetryAt=0;settleLastFrame=-1;}
function* findClearLanding():Generator<void,boolean>{
 const groundSource=terrain,citySource=buildings;if(!groundSource||!citySource)return false;
 const origin=player.clone(),initialYaw=yaw;
 function* clear(x:number,z:number,h:number):Generator<void,boolean>{
  for(let i=0;i<8;i++){
   const a=i*Math.PI/4,xx=x+Math.cos(a)*1.3,zz=z+Math.sin(a)*1.3,ground=groundSource!.heightAt(xx,zz);
   const blocked=ground===null||citySource!.blocked(xx,zz,Math.max(h,ground)+.28)||!!district?.blocked(xx,zz,Math.max(h,ground??h)+.28);yield;
   if(blocked)return false;
  }
  const blocked=citySource!.blocked(x,z,h+.28)||!!district?.blocked(x,z,h+.28);yield;return !blocked;
 }
 let landing:{x:number;z:number;h:number}|undefined;
 for(let candidate=0;candidate<=30*24;candidate++){
  const ring=Math.ceil(candidate/24),angle=((candidate-1)%24)*Math.PI/12;
  const x=origin.x+(candidate?Math.cos(angle)*ring*2:0),z=origin.z+(candidate?Math.sin(angle)*ring*2:0),h=groundSource.heightAt(x,z);yield;
  if(h!==null&&(yield* clear(x,z,h))){landing={x,z,h};break;}
 }
 if(!landing)return false;
 const {x,z,h}=landing;let best=-Infinity,heading=initialYaw;
 // Retain the original clear-direction search, yielding after each query.
 for(let i=0;i<32;i++){
  const angle=i*Math.PI/16;let distance=0;
  for(let d=2;d<=24;d+=2){
   const xx=x-Math.sin(angle)*d,zz=z-Math.cos(angle)*d,ground=groundSource.heightAt(xx,zz);
   const blocked=ground===null||Math.abs(ground-h)>2||citySource.blocked(xx,zz,ground+.28);yield;
   if(blocked)break;distance=d;
  }
  const score=distance+.25*Math.cos(angle-initialYaw);if(score>best){best=score;heading=angle;}
 }
 player.set(x,h+1.95,z);vertical=0;yaw=heading;return true;
}
function settle(){
 const now=performance.now();if(now<settleRetryAt||settleLastFrame===last)return false;
 settleLastFrame=last;if(!settleTask){settleTask=findClearLanding();settleTiming.searches++;}
 const started=performance.now();let success=false;
 do{
  const result=settleTask.next();
  if(result.done){success=result.value;settleTask=undefined;if(success)settleTiming.completed++;else{settleTiming.failed++;settleRetryAt=performance.now()+500;}break;}
 }while(performance.now()-started<3);
 const duration=performance.now()-started;settleTiming.slices++;settleTiming.totalMs+=duration;settleTiming.maxSliceMs=Math.max(settleTiming.maxSliceMs,duration);
 return success;
}

let audit:{mode:'fly'|'walk';maxYStep:number;previousY:number;started:number;duration:number;frames:number[];last:number;origin:THREE.Vector3}|null=null;let auditResult:unknown=null;
const monitor=new FrameMonitor(renderer,()=>buildings?.resize(camera,renderer));
function finishGraphicsRecovery(){
 const recovery=graphicsRecovery;if(!recovery||recovery.transition!==transition||!ready||!terrain||!buildings||enterPending)return;
 if(!terrain.readyAt(player.x,player.z)||terrain.stats.loading||terrain.stats.farBatch.building||!buildings.settled||buildings.pending)return;
 yaw=recovery.yaw;pitch=recovery.pitch;paused=recovery.paused;graphicsRecovery=null;if(recovery.reason!=='rebase'){keys.clear();tapUntil.clear();}flightMotion.reset();monitor.reset();
}
let last=performance.now(),statTime=0,fps=60,frames=0,elapsed=0;
function tick(now:number){requestAnimationFrame(tick);if(graphicsLost||cinema.capturing){last=now;monitor.resetClock();return;}if(document.hidden){last=now;monitor.resetClock();return;}if(audit){audit.maxYStep=Math.max(audit.maxYStep,Math.abs(player.y-audit.previousY));audit.previousY=player.y;if(audit.last)audit.frames.push(now-audit.last);audit.last=now;if(now-audit.started>=audit.duration){const a=audit.frames.slice().sort((x,y)=>x-y);auditResult={mode:audit.mode,maxYStep:audit.maxYStep,durationMs:now-audit.started,samples:a.length,meanMs:a.reduce((x,y)=>x+y,0)/a.length,p95Ms:a[Math.floor(a.length*.95)],p99Ms:a[Math.floor(a.length*.99)],maxMs:a.at(-1),hitches50:a.filter(x=>x>50).length,metres:player.distanceTo(audit.origin),position:player.toArray(),buildings:buildings?.stats};audit=null;paused=true;flightMotion.reset();}}
 monitor.begin(now);const rawDt=(now-last)/1000,dt=Math.min(.05,rawDt);last=now;elapsed+=rawDt;frames++;if(elapsed>.6){fps=Math.round(frames/elapsed);elapsed=0;frames=0;}
 if(ready&&terrain&&buildings&&cinema.playing){terrain.update(camera.position);buildings.update(camera.position);}
 if(ready&&terrain&&buildings&&!cinema.playing){terrain.update(player);buildings.update(player);const h=terrain.heightAt(player.x,player.z);
 if(!active&&h!==null){player.y=h+95;}
 if(enterPending&&h!==null&&buildings.settled&&buildings.pending===0&&(buildings.stats.visible>0||buildings.stats.loaded===0)){if(settle()){enterPending=false;if(arrivalFacing){yaw=arrivalFacing.yaw;pitch=arrivalFacing.pitch;arrivalFacing=null;}}}
 finishGraphicsRecovery();const canMove=active&&!paused&&!enterPending&&!graphicsRecovery&&!document.querySelector('dialog[open]');
 if(canMove){let side=(pressed('KeyD')||pressed('ArrowRight')?1:0)-(pressed('KeyA')||pressed('ArrowLeft')?1:0),forward=(pressed('KeyW')||pressed('ArrowUp')?1:0)-(pressed('KeyS')||pressed('ArrowDown')?1:0);if(audit){forward=1;side=.12*Math.sin((now-audit.started)/6000);}
 const length=Math.hypot(side,forward);if(length){side/=length;forward/=length;}const speed=fly?(pressed('ShiftLeft')?150:45):(pressed('ShiftLeft')?4.5:1.4);const dx=(Math.cos(yaw)*side-Math.sin(yaw)*forward)*speed*dt,dz=(-Math.sin(yaw)*side-Math.cos(yaw)*forward)*speed*dt;
 if(fly){const up=(pressed('KeyE')||pressed('Space')?1:0)-(pressed('KeyQ')?1:0);const previousFlightPosition=player.clone(),move=flightMotion.step(side,forward,up,yaw,pitch,pressed('ShiftLeft'),dt);const steps=Math.max(1,Math.ceil(move.length()/.4));for(let i=0;i<steps;i++){const x=player.x+move.x/steps,y=player.y+move.y/steps,z=player.z+move.z/steps;if(buildings.blocked(x,z,y-.9,1.5)||district?.blocked(x,z,y-.9,1.5)){flightMotion.reset();break;}player.set(x,y,z);}const floor=terrain.heightAt(player.x,player.z);if(floor!==null&&player.y<floor+2){player.y=floor+2;flightMotion.stopVertical();}travelled+=player.distanceTo(previousFlightPosition);}else{
 const previousWalkPosition=player.clone();const step=(x:number,z:number)=>{const raw=terrain!.heightAt(x,z);if(raw===null)return false;const feet=player.y-1.7;const ground=Math.max(raw,buildings!.supportAt(x,z,feet+.65));if(ground>feet+.65)return false;if(buildings!.blocked(x,z,Math.max(feet,ground+.26))||district?.blocked(x,z,Math.max(feet,ground+.26)))return false;return true;};if(dx&&step(player.x+dx,player.z)){player.x+=dx;}if(dz&&step(player.x,player.z+dz)){player.z+=dz;}const rawGround=terrain.heightAt(player.x,player.z);const ground=rawGround===null?null:Math.max(rawGround,buildings.supportAt(player.x,player.z,player.y-1.7+.65));if(ground!==null){vertical-=9.81*dt;player.y+=vertical*dt;if(player.y<=ground+1.95){player.y=ground+1.95;vertical=0;grounded=true;}else grounded=false;}travelled+=player.distanceTo(previousWalkPosition);
 }}
 if(active&&!fly&&!enterPending&&buildings.blocked(player.x,player.z,player.y-1.7)){enterPending=true;if(settle())enterPending=false;}
 if(Math.hypot(player.x,player.z)>4000){const g=frame.toGeo(player.x,player.y,player.z);void travel(g.lat,g.lon,place.textContent||'Tokyo',true);}
 }
 if(cinema.playing)cinema.update(now);else{camera.position.copy(player);camera.rotation.set(pitch,yaw,0);}district?.update(cinema.playing?camera.position:player,!!buildings?.settled&&buildings.pending===0&&!terrain?.stats.loading);neighborhood.update(frame,player,yaw,pitch,active&&!fly&&!cinema.playing,!enterPending&&ready&&!graphicsRecovery,place.textContent||'Shibuya');monitor.beforeRender();visual.render();monitor.end();
 if(now-statTime>400){statTime=now;const g=frame.toGeo(player.x,player.y,player.z);coordinates.textContent=`${g.lat.toFixed(5)}° N   ${g.lon.toFixed(5)}° E${active?'   ·   '+(fly?'FLIGHT':'WALK'):''}`;if(!worldError&&terrain&&buildings){const b=buildings.stats,t=terrain.stats;status.textContent=b.errors?`Source load error · ${b.visible} survey tiles loaded · Open map to retry`:graphicsRecovery?`${graphicsRecovery.reason==='rebase'?'Preparing the next survey area':'Restoring survey textures'} · ${b.visible} tiles ready`:enterPending?`Preparing surveyed streets and buildings · ${b.visible} tiles ready`:b.cacheAtCapacity?`Texture memory full · Travel to refresh nearby coverage`:b.pending?`Preparing survey textures · ${b.visible} tiles ready`:`Survey imagery · ${fps} fps`;}
 }
}
requestAnimationFrame(tick);window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();if(graphicsLost)return;renderer.setSize(innerWidth,innerHeight);visual.resize(innerWidth,innerHeight);buildings?.resize(camera,renderer);});
canvas.addEventListener('webglcontextlost',event=>{
 event.preventDefault();if(graphicsLost)return;
 const position=frame.toGeo(player.x,player.y,player.z);
 graphicsRecovery??={...position,ellipsoidHeight:position.height+frame.elevationOffset,name:place.textContent||'Tokyo',active,paused,fly,yaw,pitch,transition:-1};
 graphicsLost=true;ready=false;paused=true;transition++;keys.clear();tapUntil.clear();flightMotion.reset();resetSettle();monitor.contextLost();
 if(cinema.capturing)cinema.error='Graphics were interrupted. Capture stopped while the scene recovers.';
 cinema.stop();audit=null;
 // Abort old asynchronous builds before they can mark empty restored arrays ready.
 district?.dispose();district=undefined;buildings?.dispose();terrain?.dispose();imagery?.dispose();buildings=undefined;terrain=undefined;imagery=undefined;
 worldError='';status.textContent='Restoring graphics at your location…';
});
canvas.addEventListener('webglcontextrestored',()=>{
 graphicsLost=false;monitor.contextRestored();renderer.setSize(innerWidth,innerHeight);visual.resize(innerWidth,innerHeight);
 const recovery=graphicsRecovery;if(!recovery)return;
 void(async()=>{
  const rebuilding=travel(recovery.lat,recovery.lon,recovery.name,true,true);recovery.transition=transition;await rebuilding;
  if(graphicsLost||graphicsRecovery!==recovery||transition!==recovery.transition)return;
  if(!ready){graphicsRecovery=null;paused=recovery.paused;return;}
  restorePose(recovery);
  enterPending=active&&!fly;paused=true;vertical=0;last=performance.now();monitor.resetClock();
  document.querySelector('#fly-mode')!.textContent=fly?'Land · F':'Fly · F';
 })();
});
// Read-only diagnostic snapshot, including scene scale and data provenance.
Object.defineProperty(window,'tokyoDiagnostics',{get:()=>({position:frame.toGeo(player.x,player.y,player.z),localPosition:player.toArray(),units:'metres',yaw,pitch,active,paused,fly,enterPending,ready,graphics:{lost:graphicsLost,recovering:!!graphicsRecovery},rebase:{count:rebaseCount,last:lastRebase},geoid:frame.elevationOffset,buildings:buildings?.stats,terrain:terrain?.stats,fps,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,error:worldError||buildings?.lastError,ground:terrain?.heightAt(player.x,player.z),distance:travelled,neighborhood:neighborhood.diagnostics,district:district?.stats,performance:monitor.stats,settle:{...settleTiming,pending:!!settleTask}})});
const params=new URLSearchParams(location.search),returnPose=params.get('return')==='street'?readStreetReturn():null,initialLat=returnPose?.lat??Number(params.get('lat')||35.6595),initialLon=returnPose?.lon??Number(params.get('lon')||139.7005);
void travel(initialLat,initialLon,returnPose?.name??PLACES.find(([,lat,lon])=>Math.abs(lat-initialLat)<.00001&&Math.abs(lon-initialLon)<.00001)?.[0]??'Custom coordinates').then(()=>{
 if(returnPose&&ready){player.copy(frame.toLocal(returnPose.lat,returnPose.lon,returnPose.height));active=true;fly=false;paused=false;enterPending=true;arrivalFacing={yaw:returnPose.yaw,pitch:returnPose.pitch};document.body.classList.add('walking');}
});

Object.defineProperty(window,'tokyoStudio',{value:{exportCity:()=>exportCity([city,land]),preloadCorridor:()=>{const points=[500,250,0,-250,-500,-750].flatMap(z=>[-200,150].map(x=>new THREE.Vector3(x,145,z)));buildings?.setPreloadPoints(points,550,0);terrain?.setPreloadPoints(points);},clearPreload:()=>{buildings?.clearPreloadPoints();terrain?.setPreloadPoints([]);},inspect:()=>{const meshes:any[]=[];city.updateMatrixWorld(true);city.traverse(o=>{if((o as THREE.Mesh).isMesh){const m=o as THREE.Mesh;const box=new THREE.Box3().setFromObject(m);let visible=true;for(let p:THREE.Object3D|null=o;p;p=p.parent)visible=visible&&p.visible;meshes.push({name:m.name,visible,sourcePosition:Array.from((m.geometry.getAttribute('position').array as Float32Array).slice(0,3)),bounds:[box.min.toArray(),box.max.toArray()],triangles:(m.geometry.index?.count??m.geometry.getAttribute('position').count)/3,texture:{compressed:!!(m.material as any).map?.isCompressedTexture,width:(m.material as any).map?.image?.width,height:(m.material as any).map?.image?.height,mips:(m.material as any).map?.mipmaps?.length}});}});return {meshes,camera:camera.position.toArray(),reversed:camera.reversedDepth};},capture:()=>cinema.capture(),preview:async(time:number)=>{cinema.capturing=true;await cinema.load();cinema.sample(time);await cinema.beforeCaptureFrame?.(time);visual.render();},resume:()=>{cinema.capturing=false;},beginMotionCheck:(seconds=45)=>{if(!ready)throw Error('Scene is loading');cinema.stop();active=true;paused=false;fly=true;enterPending=false;flightMotion.reset();player.y=(terrain?.heightAt(player.x,player.z)??52)+90;yaw=0;pitch=-.04;document.body.classList.add('walking');auditResult=null;audit={mode:'fly',maxYStep:0,previousY:player.y,started:performance.now(),duration:seconds*1000,frames:[],last:0,origin:player.clone()};monitor.reset();},beginWalkCheck:(seconds=20,heading?:number)=>{if(!active||fly||enterPending)throw Error('Enter walking mode first');if(heading!==undefined&&Number.isFinite(heading))yaw=heading;paused=false;auditResult=null;audit={mode:'walk',maxYStep:0,previousY:player.y,started:performance.now(),duration:seconds*1000,frames:[],last:0,origin:player.clone()};monitor.reset();},get motionCheck(){return {running:!!audit,result:auditResult};},get captureProgress(){return cinema.progress;},get captureError(){return cinema.error;},get cinema(){return {playing:cinema.playing,capturing:cinema.capturing,visual:visual.status};}}});

let preparedTransition=-1;
cinema.onStop=()=>{buildings?.clearPreloadPoints();terrain?.setPreloadPoints([]);preparedTransition=-1;};
cinema.prepare=async()=>{
 if(preparedTransition===transition)return;
 const data=await cinema.load(),points=data.samples.filter((_,i)=>i%540===0).map(s=>new THREE.Vector3().fromArray(s.position));
 buildings?.setPreloadPoints(points,550,0);terrain?.setPreloadPoints(points);
 const token=transition,deadline=performance.now()+240000;let stable=0;
 while(performance.now()<deadline){
  if(token!==transition)throw Error('Destination changed while preparing the flight.');
  if(buildings?.settled&&buildings.pending===0&&terrain?.stats.loading===0&&!terrain.stats.farBatch.building)stable++;else stable=0;
  if(stable>=5){preparedTransition=transition;return;}
  await new Promise(r=>setTimeout(r,200));
 }
 throw Error('The flight corridor is still loading from the survey source. Please retry shortly.');
};
let captureCheckpoint=-1;
cinema.beforeCaptureFrame=async(time)=>{
 if(graphicsLost||graphicsRecovery)throw Error('Graphics are recovering. Start the capture again when the survey is ready.');
 const checkpoint=Math.floor(time*2);if(checkpoint===captureCheckpoint)return;captureCheckpoint=checkpoint;
 const deadline=performance.now()+45000;let stable=0;
 do{terrain?.update(camera.position);buildings?.update(camera.position);
  if(buildings?.settled&&buildings.pending===0&&terrain?.stats.loading===0&&!terrain.stats.farBatch.building)stable++;else stable=0;
  if(stable>=2)return;await new Promise(r=>setTimeout(r,60));
 }while(performance.now()<deadline);
 throw Error('Survey data did not finish loading at the capture position.');
};
document.querySelector('#flight')!.addEventListener('click',async()=>{
 const button=document.querySelector<HTMLButtonElement>('#flight')!;button.disabled=true;button.textContent='Preparing the flight…';
 try{if(Math.abs(frame.lat-35.6595)>.00001||Math.abs(frame.lon-139.7005)>.00001)await travel(35.6595,139.7005,'Shibuya');await cinema.play();}
 catch(e){say(String((e as Error).message));}finally{button.disabled=false;button.textContent='Take the cinematic flight ↗';}
});
document.querySelector('#stop-flight')!.addEventListener('click',()=>cinema.stop());

window.addEventListener('pagehide',()=>{district?.dispose();district=undefined;buildings?.dispose();terrain?.dispose();imagery?.dispose();visual.dispose();renderer.dispose();});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
