import * as THREE from 'three';
import {FlightMotion} from './flight-motion';
import {streetReturnURL} from './street-return';
import {ScanScene,type ScanLocation} from './scan-scene';
import {MeshIndoorScene} from './mesh-indoor-scene';

const canvas=document.querySelector<HTMLCanvasElement>('#scan')!,status=document.querySelector<HTMLElement>('#status')!,loading=document.querySelector<HTMLElement>('#loading')!;
const floorSelect=document.querySelector<HTMLSelectElement>('#floor')!,mode=document.querySelector<HTMLButtonElement>('#mode')!,about=document.querySelector<HTMLDialogElement>('#about-dialog')!;
const datasetSelect=document.querySelector<HTMLSelectElement>('#dataset')!;
const renderer=new THREE.WebGLRenderer({canvas,antialias:true,powerPreference:'high-performance'});renderer.setPixelRatio(Math.min(devicePixelRatio,1.25));renderer.setSize(innerWidth,innerHeight);renderer.outputColorSpace=THREE.SRGBColorSpace;
const scene=new THREE.Scene();scene.background=new THREE.Color('#111819');
scene.add(new THREE.HemisphereLight(0xf5fff3,0x7f9696,2.2));const light=new THREE.DirectionalLight(0xfff2de,1.8);light.position.set(-3,8,4);scene.add(light);
renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.1;
const camera=new THREE.PerspectiveCamera(66,innerWidth/innerHeight,.045,70);camera.rotation.order='YXZ';
const group=new THREE.Group();scene.add(group);let scan:ScanScene|MeshIndoorScene=new ScanScene(group,camera,renderer);
const position=new THREE.Vector3(147.75,-7.90314696,-273.75),candidate=new THREE.Vector3(),motion=new FlightMotion();
let yaw=0,pitch=-.03,fly=false,paused=false,ready=false,waitingForFloor=true,locationLoading=false,selectedFloor:ScanLocation|undefined,datasetGeneration=0,travelGeneration=0;
const datasets={shibuya:{title:'Shibuya Underground',url:'/captures/shibuya-underground-2017/manifest.json',mesh:false},takeshiba:{title:'Takeshiba interiors',url:'/captures/takeshiba-interior/manifest.json',mesh:true},'tokyo-station':{title:'Tokyo Station interiors',url:'/captures/tokyo-station-interior/manifest.json',mesh:true}};
if(new URLSearchParams(location.search).has('entrance')){const back=document.querySelector<HTMLAnchorElement>('.back')!;back.href=streetReturnURL();back.textContent='↖ Return to the street entrance';}
const keys=new Set<string>();let dragging=false;
function clearInput(){keys.clear();motion.reset();dragging=false;}
function switchMode(){fly=!fly;paused=false;waitingForFloor=!fly;motion.reset();mode.textContent=fly?'Walk · F':'Fly · F';document.querySelector('#controls')!.textContent=fly?'Drag to look · WASD fly · E / Q altitude · Shift faster':'Drag to look · WASD walk · Shift faster · F fly';}
async function travel(destination:ScanLocation){
  clearInput();const token=++travelGeneration,owner=scan;locationLoading=true;waitingForFloor=true;loading.hidden=false;loading.textContent='Preparing the measured floor';
  try{
    if(owner instanceof MeshIndoorScene)await owner.selectLocation(destination.id);
    if(scan!==owner||token!==travelGeneration)return;
    selectedFloor=destination;position.fromArray(destination.position);yaw=destination.yaw??0;pitch=destination.pitch??-.03;fly=false;paused=false;locationLoading=false;mode.textContent='Fly · F';document.querySelector('#place')!.textContent=destination.label;floorSelect.value=destination.id;document.querySelector('#controls')!.textContent='Drag to look · WASD walk · Shift faster · F fly';const url=new URL(location.href);url.searchParams.set('floor',destination.id);history.replaceState(null,'',url);
  }catch(error){if(token===travelGeneration)loading.textContent=String((error as Error).message||error);}
}
floorSelect.addEventListener('change',()=>{const destination=scan.manifest?.locations.find(item=>item.id===floorSelect.value);if(destination)void travel(destination);});
datasetSelect.addEventListener('change',()=>void openDataset(datasetSelect.value as keyof typeof datasets));
mode.addEventListener('click',switchMode);
canvas.addEventListener('pointerdown',event=>{if(event.button!==0)return;dragging=true;paused=false;canvas.setPointerCapture(event.pointerId);});
canvas.addEventListener('pointerup',event=>{dragging=false;canvas.releasePointerCapture(event.pointerId);});
canvas.addEventListener('pointermove',event=>{if(!dragging&&document.pointerLockElement!==canvas)return;yaw-=event.movementX*.002;pitch=THREE.MathUtils.clamp(pitch-event.movementY*.002,-1.45,1.45);});
canvas.addEventListener('dblclick',()=>{paused=false;canvas.requestPointerLock()?.catch(()=>{});});
document.addEventListener('pointerlockchange',()=>{keys.clear();motion.reset();});window.addEventListener('blur',clearInput);
document.addEventListener('keydown',event=>{
  if((event.target as HTMLElement).matches('select,input,textarea')||about.open)return;
  if(event.code==='Escape'){paused=true;clearInput();return;}
  if(event.code==='KeyF'&&!event.repeat){switchMode();return;}
  if(['KeyW','KeyA','KeyS','KeyD','KeyE','KeyQ','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','ShiftLeft','ShiftRight'].includes(event.code)){keys.add(event.code);paused=false;event.preventDefault();}
});document.addEventListener('keyup',event=>keys.delete(event.code));
document.querySelector('#about')!.addEventListener('click',()=>{document.exitPointerLock();clearInput();about.showModal();});document.querySelector('#close-about')!.addEventListener('click',()=>about.close());
window.addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);});
canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();loading.hidden=false;loading.textContent='Graphics were interrupted. Reload to resume the scan.';});

const pressed=(...codes:string[])=>codes.some(code=>keys.has(code));
let last=performance.now(),lastStatus=0,frameTimes:number[]=[],fps=60,travelled=0;
let audit:{started:number;duration:number;frames:number[];origin:THREE.Vector3}|null=null,auditResult:unknown=null;
function tick(now:number){
  requestAnimationFrame(tick);const elapsed=now-last,dt=Math.min(.04,elapsed/1000);last=now;
  if(document.hidden){clearInput();return;}
  if(elapsed<1000){frameTimes.push(elapsed);if(frameTimes.length>180)frameTimes.shift();}
  if(audit){audit.frames.push(elapsed);if(now-audit.started>=audit.duration){const frames=audit.frames.sort((a,b)=>a-b);auditResult={samples:frames.length,meanMs:frames.reduce((a,b)=>a+b,0)/frames.length,p95Ms:frames[Math.floor(frames.length*.95)],p99Ms:frames[Math.floor(frames.length*.99)],maxMs:frames.at(-1),hitches50:frames.filter(ms=>ms>50).length,metres:position.distanceTo(audit.origin),position:position.toArray(),scan:scan.stats};audit=null;paused=true;}}
  if(ready&&!locationLoading){
    const floor=scan.groundAt(position.x,position.z,position.y-1.65);
    if(waitingForFloor&&floor!==null&&!scan.blocked(position)){position.y=floor+1.65;waitingForFloor=false;loading.hidden=true;}
    if(fly){waitingForFloor=false;loading.hidden=true;}
    if(!paused&&!about.open&&!waitingForFloor){
      let side=(pressed('KeyD','ArrowRight')?1:0)-(pressed('KeyA','ArrowLeft')?1:0),forward=(pressed('KeyW','ArrowUp')?1:0)-(pressed('KeyS','ArrowDown')?1:0);
      if(audit){forward=1;side=0;}
      const length=Math.hypot(side,forward);if(length>1){side/=length;forward/=length;}
      if(fly){
        const up=(pressed('KeyE','Space')?1:0)-(pressed('KeyQ')?1:0),move=motion.step(side,forward,up,yaw,pitch,false,dt).multiplyScalar(pressed('ShiftLeft','ShiftRight')?.45:.16);
        const steps=Math.max(1,Math.ceil(move.length()/.12));
        for(let step=0;step<steps;step++){candidate.copy(position).addScaledVector(move,1/steps);if(scan.blocked(candidate,.5)){motion.reset();break;}travelled+=candidate.distanceTo(position);position.copy(candidate);}
      }else{
        const speed=pressed('ShiftLeft','ShiftRight')?2.8:1.4,dx=(Math.cos(yaw)*side-Math.sin(yaw)*forward)*speed*dt,dz=(-Math.sin(yaw)*side-Math.cos(yaw)*forward)*speed*dt;
        const walk=(x:number,z:number)=>{const ground=scan.groundAt(x,z,position.y-1.65);if(ground===null)return;candidate.set(x,Math.max(position.y,ground+1.65),z);if(scan.blocked(candidate))return;travelled+=Math.hypot(x-position.x,z-position.z);position.x=x;position.z=z;position.y+=((ground+1.65)-position.y)*(1-Math.exp(-18*dt));};
        if(dx)walk(position.x+dx,position.z);if(dz)walk(position.x,position.z+dz);
      }
    }
  }
  camera.position.copy(position);camera.rotation.set(pitch,yaw,0);scan.update(position);if(scan instanceof ScanScene)scan.render(scene);else renderer.render(scene,camera);
  if(now-lastStatus>400){
    lastStatus=now;fps=Math.round(1000/(frameTimes.reduce((a,b)=>a+b,0)/Math.max(1,frameTimes.length)));const stats=scan.stats;
    status.textContent=stats.error?'Source interrupted · Select a floor to retry':stats.pending?`${stats.readyTiles} / ${stats.wantedTiles} nearby tiles · ${fps} fps`:'rooms'in stats?`${stats.rooms} surveyed rooms · ${fps} fps`:`${(stats.visiblePoints/1e6).toFixed(2)}M measured points · ${fps} fps`;
    document.querySelector('#error')!.textContent=stats.error;
  }
}
requestAnimationFrame(tick);
async function openDataset(id:keyof typeof datasets){
  const dataset=datasets[id]??datasets.shibuya,token=++datasetGeneration;travelGeneration++;clearInput();ready=false;locationLoading=false;waitingForFloor=true;selectedFloor=undefined;scan.dispose();
  scan=dataset.mesh?new MeshIndoorScene(group,camera,renderer):new ScanScene(group,camera,renderer);const owner=scan;
  datasetSelect.value=id;floorSelect.replaceChildren(new Option('Loading floors…'));loading.hidden=false;loading.textContent=`Opening ${dataset.title}`;
  document.querySelector('#dataset-title')!.textContent=dataset.title;document.querySelector('#about-title')!.textContent=dataset.title;document.title=`${dataset.title} · Tokyo`;canvas.setAttribute('aria-label',`${dataset.title} measured interior`);
  const url=new URL(location.href);if(url.searchParams.get('dataset')!==id)url.searchParams.delete('floor');url.searchParams.set('dataset',id);history.replaceState(null,'',url);
  try{
    await owner.load(dataset.url);if(token!==datasetGeneration)return;
    const locations=owner.manifest!.locations;floorSelect.replaceChildren(...locations.map(destination=>new Option(destination.label,destination.id)));
    document.querySelector('#description')!.textContent=dataset.mesh?'Explore the published room geometry, floors, walls and passages at their measured scale. Surfaces retain supplied colours and textures. Walking support and wall contact come from the original geometry.':'The station contains 28.6 million measured colour laser points. Every published point and its original RGB colour are preserved. Walking support and wall contact come from the same captured surfaces.';
    document.querySelector('#source-credit')!.textContent=dataset.mesh?'PLATEAU indoor survey · Original room geometry':'2017 laser survey · Original captured colour';
    document.querySelector('#capture-note')!.textContent=dataset.mesh?'Floor viewpoints and coverage follow the published indoor survey.':'The scan records the station as captured in March 2017. Floor viewpoints follow measured clear areas. Coverage follows the published capture.';
    const credit=document.querySelector('#credit')!;credit.replaceChildren();
    const source=document.createElement('a');source.target='_blank';source.rel='noreferrer';source.href=owner instanceof MeshIndoorScene?(owner.manifest?.source??owner.manifest?.sourceURL??'https://www.mlit.go.jp/plateau/'):owner.manifest!.source;source.textContent=owner instanceof MeshIndoorScene?(owner.manifest?.attribution??'Project PLATEAU'):owner.manifest!.copyright;
    credit.append('Source: ',source);if(owner.manifest?.license)credit.append(` · ${owner.manifest.license}`);
    const initial=locations.find(destination=>destination.id===new URLSearchParams(location.search).get('floor'))??locations.find(destination=>destination.id==='b5')??locations[0];
    if(!initial)throw new Error('The published interior has no starting viewpoint.');ready=true;await travel(initial);
  }catch(error){if(token===datasetGeneration){loading.hidden=false;loading.textContent=String((error as Error).message||error);}}
}
const requestedDataset=new URLSearchParams(location.search).get('dataset')??'shibuya';void openDataset(requestedDataset in datasets?requestedDataset as keyof typeof datasets:'shibuya');

Object.defineProperty(window,'tokyoScan',{value:{
  get diagnostics(){return {position:position.toArray(),yaw,pitch,fly,paused,ready,waitingForFloor,selectedFloor:selectedFloor?.id,fps,travelled,scan:scan.stats,drawCalls:renderer.info.render.calls,renderedPoints:renderer.info.render.points};},
  get locations(){return scan.manifest?.locations;},
  visit:(id:string)=>{const destination=scan.manifest?.locations.find(item=>item.id===id);if(!destination)throw new Error('Unknown measured floor.');return travel(destination);},
  beginWalkCheck:(seconds=15)=>{if(waitingForFloor||!ready)throw new Error('The measured floor is still loading.');if(fly)switchMode();paused=false;auditResult=null;audit={started:performance.now(),duration:seconds*1000,frames:[],origin:position.clone()};},
  get motionCheck(){return {running:!!audit,result:auditResult};},
}});
window.addEventListener('pagehide',()=>{scan.dispose();renderer.dispose();});

window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
