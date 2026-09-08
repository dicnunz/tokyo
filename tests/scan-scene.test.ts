import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeScanTile,decodeScanSurfels,ScanCollision,type ScanTile} from '../src/scan-scene.ts';

const size=8,scale=size/65535;
function encode(points:Array<[number,number,number,number,number,number]>){
  const buffer=new ArrayBuffer(points.length*9),view=new DataView(buffer);
  points.forEach((point,i)=>{for(let axis=0;axis<3;axis++)view.setUint16(i*9+axis*2,Math.round(point[axis]/scale),true);for(let c=0;c<3;c++)view.setUint8(i*9+6+c,point[c+3]);});
  return buffer;
}
function source(count:number):ScanTile{return {id:'0_0_0',url:'tile.bin',count,offset:[0,0,0],scale,bounds:[[0,0,0],[8,8,8]]};}

test('scan decoding preserves every point and every RGB byte at recorded precision',()=>{
  const points:Array<[number,number,number,number,number,number]>=[[0,0,0,0,255,17],[8,8,8,255,0,94],[3.24567,1.54321,6.13579,33,66,99]];
  const decoded=decodeScanTile(encode(points),scale);
  assert.equal(decoded.positions.length,points.length*3);assert.equal(decoded.colors.length,points.length*3);
  points.forEach((point,i)=>{for(let axis=0;axis<3;axis++)assert.ok(Math.abs(decoded.positions[i*3+axis]*scale-point[axis])<=scale/2+1e-12);assert.deepEqual([...decoded.colors.subarray(i*3,i*3+3)],point.slice(3));});
  assert.throws(()=>decodeScanTile(new ArrayBuffer(8),scale),/Incomplete/);
});

test('background decode function is self-contained and transferable',()=>{
  const workerDecode=new Function(`return (${decodeScanTile.toString()})`)() as typeof decodeScanTile;
  const result=workerDecode(encode([[1,2,3,7,8,9]]),scale);
  assert.deepEqual([...result.colors],[7,8,9]);assert.equal(result.positions.length,3);
});

test('surface direction sidecars retain signed normals and unsigned millimetre radii',()=>{
  const bytes=new Uint8Array([0,127,0,93,129,0,0,125]),surfels=decodeScanSurfels(bytes.buffer,2);
  assert.deepEqual([...surfels],[0,127,0,93,-127,0,0,125]);
  assert.equal(surfels.buffer,bytes.buffer,'Surface direction uploads use the transferred bytes directly.');
  assert.throws(()=>decodeScanSurfels(bytes.buffer,3),/Incomplete/);
});

test('measured floor supports walking while vertical surfaces block the body',()=>{
  const points:Array<[number,number,number,number,number,number]>=[];
  for(let z=1;z<7;z+=.08)for(let x=1;x<7;x+=.08)points.push([x,1,z,70,80,90]);
  for(let z=1;z<7;z+=.08)for(let y=1;y<4;y+=.08)points.push([4,y,z,100,110,120]);
  const collision=new ScanCollision(),tile=source(points.length);collision.add(tile,decodeScanTile(encode(points),scale));
  assert.ok(Math.abs(collision.groundAt(2,3,1)!-1)<.001);
  assert.equal(collision.blocked(2,2.65,3),false,'Floor points do not obstruct the standing body.');
  assert.equal(collision.blocked(3.9,2.65,3),true,'Measured wall points stop the body before it passes through.');
  assert.equal(collision.groundAt(2,3,5),null,'A distant surface never teleports the walker between storeys.');
  collision.remove(tile);assert.equal(collision.groundAt(2,3,1),null,'Unloaded geometry supplies no fabricated floor.');
});

test('a vertical wall by itself never becomes walking support',()=>{
  const points:Array<[number,number,number,number,number,number]>=[];
  for(let z=1;z<7;z+=.05)for(let y=1;y<4;y+=.05)points.push([4,y,z,100,110,120]);
  const collision=new ScanCollision();collision.add(source(points.length),decodeScanTile(encode(points),scale));
  assert.equal(collision.groundAt(4,3,2),null,'Floor support requires agreement across a two-dimensional footprint.');
});
