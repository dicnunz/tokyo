import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Quaternion, Vector3 } from 'three';
const route=JSON.parse(readFileSync(new URL('../public/cinema/camera.json',import.meta.url),'utf8'));
const samples=route.samples as {time:number;position:number[];quaternion:number[];fov:number}[];
const position=(s:typeof samples[number])=>new Vector3().fromArray(s.position);
const quaternion=(s:typeof samples[number])=>new Quaternion().fromArray(s.quaternion).normalize();

test('Blender flight maintains forward progress, constant altitude and constant speed',()=>{
 assert.equal(samples.length,route.duration*route.fps+1);
 const first=position(samples[0]),speeds:number[]=[];
 for(let i=0;i<samples.length;i++){
  const sample=samples[i],p=position(sample);
  assert.ok(sample.position.every(Number.isFinite));
  assert.ok(Math.abs(sample.time-i/route.fps)<1e-6);
  assert.ok(Math.abs(p.y-first.y)<1e-4,'camera never bobs vertically');
  assert.equal(sample.fov,58,'no zoom breathing');
  if(i){assert.ok(p.z<samples[i-1].position[2],'every frame moves north into new city');speeds.push(p.distanceTo(position(samples[i-1]))*route.fps);}
 }
 const mean=speeds.reduce((a,b)=>a+b,0)/speeds.length;
 assert.ok(mean>20&&mean<25);
 assert.ok(speeds.every(speed=>Math.abs(speed/mean-1)<.01),'arc-length resampling keeps speed within 1%');
 assert.ok(first.distanceTo(position(samples.at(-1)!))>950,'covers multiple city blocks');
});

test('camera follows travel direction with stable up and gentle angular rates',()=>{
 for(let i=0;i<samples.length;i++){
  const s=samples[i],q=quaternion(s);
  assert.ok(Math.abs(s.quaternion.reduce((sum,n)=>sum+n*n,0)-1)<1e-5);
  const forward=new Vector3(0,0,-1).applyQuaternion(q);
  const right=new Vector3(1,0,0).applyQuaternion(q);
  assert.ok(Math.abs(right.y)<1e-5,'no artificial banking');
  assert.ok(Math.abs(Math.asin(-forward.y)*180/Math.PI-28)<.01,'keeps city in frame');
  const previous=position(samples[Math.max(0,i-180)]),next=position(samples[Math.min(samples.length-1,i+180)]);
  const motion=next.sub(previous).setY(0).normalize();
  assert.ok(forward.clone().setY(0).normalize().dot(motion)>.999,'looks forward rather than fixing on one tower');
  if(i)assert.ok(q.angleTo(quaternion(samples[i-1]))*180/Math.PI*route.fps<5.01,'rotation stays below 5 degrees per second');
 }
});

test('frustum coverage accounts for oblique fog-plane corners rather than only the centre ray',()=>{
 const sample=samples[Math.floor(samples.length/2)],q=quaternion(sample),camera=position(sample);
 const tan=Math.tan(sample.fov*Math.PI/360),aspect=16/9,fogFar=1150;
 // Find the screen y whose world ray meets measured ground at the fog plane.
 // Unnormalised camera-space z=-1 means distance here is fog view-depth.
 const up=new Vector3(0,1,0).applyQuaternion(q),centre=new Vector3(0,0,-1).applyQuaternion(q);
 const y=((route.measuredGroundReferenceMeters-camera.y)/fogFar-centre.y)/(up.y*tan);
 assert.ok(y>-1&&y<1,'ground meets the far fog plane inside the picture');
 const corner=new Vector3(tan*aspect,y*tan,-1).applyQuaternion(q).multiplyScalar(fogFar);
 assert.ok(Math.hypot(corner.x,corner.z)>1300,'a 1.3 km terrain circle cannot cover every visible corner at fogFar=1150');
 assert.ok(Math.hypot(corner.x,corner.z)<1700,'1.7 km conservative coverage includes this 1080p frustum');
 const remainingOpacity=1-((550-450)/(1150-450))**2*(3-2*(550-450)/(1150-450));
 assert.ok(remainingOpacity>.94,'buildings truncated at 550m remain clearly visible with current fog');
});
