import test from 'node:test';
import assert from 'node:assert/strict';
import {Vector3} from 'three';
import {roomBlocked,insideBox,findFloorLanding} from '../src/interior-world.ts';

test('walking capsule clears a one metre aisle and contacts its furniture edges',()=>{
 const boxes=[{min:[-2,0,-3],max:[-.5,1.4,3]},{min:[.5,0,-3],max:[2,1.4,3]}] as any;
 for(let z=-3;z<3;z+=.1)assert.equal(roomBlocked(new Vector3(0,1.7,z),boxes),false);
 assert.equal(roomBlocked(new Vector3(.24,1.7,0),boxes),true);
 assert.equal(roomBlocked(new Vector3(-.24,1.7,0),boxes),true);
});
test('ceiling fittings do not block the floor but collide in flight',()=>{
 const boxes=[{min:[-1,2.5,-1],max:[1,3.2,1]}] as any;
 assert.equal(roomBlocked(new Vector3(0,1.7,0),boxes),false);
 assert.equal(roomBlocked(new Vector3(0,2.6,0),boxes),true);
});
test('circular contact allows clearance past a table corner without square-radius snagging',()=>{
 const boxes=[{min:[0,0,0],max:[2,1.2,2]}] as any;
 assert.equal(roomBlocked(new Vector3(-.2,1.7,-.2),boxes),false);
 assert.equal(roomBlocked(new Vector3(-.1,1.7,-.1),boxes),true);
});
test('room bounds and doorway volumes use all three physical axes',()=>{
 const box={min:[-6,0,-9],max:[6,3.5,5]} as any;
 assert.equal(insideBox(new Vector3(0,1.7,4),box),true);
 assert.equal(insideBox(new Vector3(0,1.7,5.1),box),false);
 assert.equal(insideBox(new Vector3(0,4,0),box),false);
});
test('landing from above a counter finds a nearby unobstructed floor',()=>{
 const bounds={min:[-6,0,-9],max:[6,4,5]} as any,boxes=[{min:[1,0,-5],max:[3.5,1.3,0]}] as any;
 const landing=findFloorLanding(new Vector3(2.3,3.6,-3),bounds,position=>roomBlocked(position,boxes));
 assert.ok(landing);assert.equal(landing.y,1.7);assert.equal(roomBlocked(landing,boxes),false);
});
