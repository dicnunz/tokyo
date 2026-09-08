import * as THREE from 'three';
import type {CinematicRenderer} from './cinematic-renderer';
type Sample={time:number;position:number[];quaternion:number[];fov:number};
export class CinemaFlight{
 onStop:(()=>void)|null=null;prepare:(()=>Promise<void>)|null=null;beforeCaptureFrame:((time:number)=>Promise<void>)|null=null;
 data:{fps:number;duration:number;samples:Sample[]}|null=null;playing=false;capturing=false;started=0;progress=0;error='';
 constructor(private camera:THREE.PerspectiveCamera,private renderer:THREE.WebGLRenderer,private visual:CinematicRenderer){}
 async load(){if(!this.data){const r=await fetch('/cinema/camera.json');if(!r.ok)throw Error('The Blender flight is still being prepared.');this.data=await r.json();}return this.data!;}
 async play(){await this.load();await this.prepare?.();this.playing=true;this.started=performance.now();document.body.classList.add('cinema');document.exitPointerLock();}
 stop(){this.onStop?.();this.playing=false;document.body.classList.remove('cinema');this.camera.fov=65;this.camera.updateProjectionMatrix();}
 sample(time:number){const data=this.data!,frame=Math.min(data.samples.length-1,Math.max(0,time*data.fps)),a=data.samples[Math.floor(frame)],b=data.samples[Math.min(data.samples.length-1,Math.ceil(frame))],t=frame%1;this.camera.position.fromArray(a.position).lerp(new THREE.Vector3().fromArray(b.position),t);this.camera.quaternion.fromArray(a.quaternion).slerp(new THREE.Quaternion().fromArray(b.quaternion),t);this.camera.fov=THREE.MathUtils.lerp(a.fov,b.fov,t);this.camera.updateProjectionMatrix();}
 update(now:number){if(!this.playing)return;const time=(now-this.started)/1000;if(time>this.data!.duration){this.stop();return;}this.sample(time);}
 async capture(){
  await this.load();await this.visual.ready;await this.prepare?.();this.capturing=true;this.error='';this.progress=0;
  const canvas=this.renderer.domElement,oldSize=this.renderer.getSize(new THREE.Vector2()),oldRatio=this.renderer.getPixelRatio(),chunks:Uint8Array[]=[];
  let encoder:VideoEncoder|undefined;
  try{
   const config:VideoEncoderConfig={codec:'avc1.64002a',width:1920,height:1080,bitrate:24_000_000,framerate:60,hardwareAcceleration:'prefer-hardware',avc:{format:'annexb'}};
   if(!(await VideoEncoder.isConfigSupported(config)).supported)throw Error('H.264 capture unavailable');
   encoder=new VideoEncoder({output:chunk=>{const bytes=new Uint8Array(chunk.byteLength);chunk.copyTo(bytes);chunks.push(bytes);},error:e=>{this.error=e.message;}});encoder.configure(config);
   this.renderer.setPixelRatio(1);this.renderer.setSize(1920,1080,false);this.camera.aspect=16/9;this.visual.setQuality('capture');this.visual.resize(1920,1080);
   const frames=Math.round(this.data!.duration*60);
   for(let frame=0;frame<frames;frame++){
    if(this.error)throw Error(this.error);this.sample(frame/60);await this.beforeCaptureFrame?.(frame/60);this.visual.render();
    const videoFrame=new VideoFrame(canvas,{timestamp:Math.round(frame/60*1e6),duration:Math.round(1e6/60)});encoder.encode(videoFrame,{keyFrame:frame%120===0});videoFrame.close();this.progress=(frame+1)/frames;
    while(encoder.encodeQueueSize>5)await new Promise(r=>setTimeout(r,4));
    if(frame%3===0)await new Promise(r=>setTimeout(r,0));
   }
   await encoder.flush();const r=await fetch('/api/cinema-video',{method:'POST',body:new Blob(chunks as BlobPart[],{type:'video/h264'})});if(!r.ok)throw Error(await r.text());return{frames,width:1920,height:1080,fps:60,seconds:this.data!.duration,bytes:chunks.reduce((s,b)=>s+b.length,0)};
  }catch(e){this.error=String(e);throw e;}finally{encoder?.close();this.capturing=false;this.renderer.setPixelRatio(oldRatio);this.renderer.setSize(oldSize.x,oldSize.y,false);this.camera.aspect=oldSize.x/oldSize.y;this.camera.fov=65;this.camera.updateProjectionMatrix();this.visual.setQuality('interactive');this.visual.resize(oldSize.x,oldSize.y);}
 }
}
