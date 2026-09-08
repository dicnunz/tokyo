import test from 'node:test';
import assert from 'node:assert/strict';
import {SourceCollision,indexSourceGeometry} from '../src/source-collision.ts';
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function collider(p:number[],i:number[]){return new SourceCollision(indexSourceGeometry([{positions:new Float32Array(p),indices:new Uint32Array(i),matrix:identity}]));}
test('original sloped survey surfaces remain continuous across collision buckets',()=>{
 const c=collider([0,0,0,64,6.4,0,64,6.4,8,0,0,8],[0,2,1,0,3,2]);
 for(let x=.05;x<64;x+=.13)assert.ok(Math.abs(c.supportAt(x,4,100)-x*.1)<1e-6);
 assert.equal(c.supportAt(-1,4,100),-Infinity);assert.equal(c.supportAt(32,4,2),-Infinity);
});
test('original angled walls collide at their actual surface and retain clearance',()=>{
 const c=collider([2,0,2,8,0,8,8,4,8,2,4,2],[0,1,2,0,2,3]);
 assert.equal(c.blocked(4,4,0,1.75),true);assert.equal(c.blocked(4,4.8,0,1.75),false);assert.equal(c.blocked(4,4,5,1.75),false);
});
test('exact bridge surfaces allow walking underneath and support on top',()=>{
 const c=collider([0,10,0,10,10,0,10,10,10,0,10,10,5,0,3,5,10,3,5,10,5],[0,2,1,0,3,2,4,5,6]);
 assert.equal(c.supportAt(2,2,2),-Infinity);assert.equal(c.supportAt(2,2,11),10);assert.equal(c.blocked(2,2,0,1.75),false);assert.equal(c.blocked(5,3.2,0,1.75),true);
});
test('collision indexing applies source transforms without changing source positions',()=>{
 const positions=new Float32Array([0,0,0,1,0,0,0,0,1]);
 const c=new SourceCollision(indexSourceGeometry([{positions,indices:new Uint32Array([0,1,2]),matrix:[1,0,0,0,0,1,0,0,0,0,1,0,10,3,-10,1]}]));
 assert.equal(c.supportAt(10.2,-9.8,10),3);assert.deepEqual(Array.from(positions),[0,0,0,1,0,0,0,0,1]);
});
test('body contact checks both sides of a spatial bucket boundary',()=>{
 const c=collider([8,0,0,8,3,0,8,3,4,8,0,4],[0,1,2,0,2,3]);
 assert.equal(c.blocked(7.8,2,0,1.75),true);assert.equal(c.blocked(8.2,2,0,1.75),true);assert.equal(c.blocked(7.6,2,0,1.75),false);
});
test('ground road subset excludes unrelated elevated triangles',()=>{
 const data=indexSourceGeometry([{positions:new Float32Array([0,2,0,10,2,0,0,2,10,0,12,0,10,12,0,0,12,10]),indices:new Uint32Array([0,1,2,3,4,5]),matrix:identity,groundTriangles:new Uint32Array([0])}]);
 const c=new SourceCollision(data);assert.equal(c.supportAt(2,2,100),12);assert.equal(c.groundSupportAt(2,2),2);assert.equal(c.groundSupportAt(20,20),-Infinity);assert.deepEqual(data.groundBounds,[0,0,10,10]);
});

test('actual ground provider feathers outside the footprint with interpolated edge height',()=>{
 const data=indexSourceGeometry([{positions:new Float32Array([0,2,0,10,12,0,0,2,10,0,40,0,10,40,0,0,40,10]),indices:new Uint32Array([0,1,2,3,4,5]),matrix:identity,groundTriangles:new Uint32Array([0])}]);
 const c=new SourceCollision(data);
 const inside=c.sampleGroundRoad(2,2)!;assert.equal(inside.distance,0);assert.ok(Math.abs(inside.height-4)<1e-10);
 assert.deepEqual(c.sampleGroundRoad(5,-2),{height:7,distance:2});
 assert.deepEqual(c.sampleGroundRoad(5,-3),{height:7,distance:3});
 assert.equal(c.sampleGroundRoad(5,-3.01),null);
 const corner=c.sampleGroundRoad(-1,-1)!;assert.equal(corner.height,2);assert.ok(Math.abs(corner.distance-Math.SQRT2)<1e-12);
 // Query lies across an 8 m indexing boundary; only the at-grade triangle counts.
 assert.deepEqual(c.sampleGroundRoad(8,-2),{height:10,distance:2});
 assert.ok(Math.abs(c.supportAt(2,2,100)-40)<1e-10);
});
test('camera clearance accounts for the near-plane corners',()=>{
 const c=collider([8,0,0,8,3,0,8,3,4,8,0,4],[0,1,2,0,2,3]);
 assert.equal(c.blocked(7.7,2,0,1.75),true);
 assert.equal(c.blocked(7.7,2,0,1.75,.24),false);
 assert.equal(c.blocked(7.6,2,0,1.75),false);
});
