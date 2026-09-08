import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FlightMotion} from '../src/flight-motion.ts';
test('flight displacement and braking remain consistent at30,60and144fps',()=>{
  const run=(fps:number)=>{const motion=new FlightMotion();let z=0;for(let i=0;i<fps*2;i++)z+=motion.step(0,1,0,0,0,false,1/fps).z;for(let i=0;i<fps*3;i++)z+=motion.step(0,0,0,0,0,false,1/fps).z;return z;};
  assert.ok(Math.abs(run(30)-run(144))<1e-9);assert.ok(Math.abs(run(60)+44)<.0001);
});
test('flight follows the view direction and limits diagonal speed',()=>{
  const motion=new FlightMotion();let length=0;for(let i=0;i<120;i++){const d=motion.step(1,1,1,.4,.3,false,1/60);assert.ok(d.y>0);length+=d.length();}assert.ok(length<44&&length>30);
});
