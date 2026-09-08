import test from 'node:test';
import {recordingRenderer} from './recording-renderer.ts';
const gpu=recordingRenderer();
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { MeshBasicMaterial,Mesh,BufferGeometry,DataTexture,Group } from 'three';
import { GeoFrame } from '../src/geo.ts';
const hooks=registerHooks({resolve(specifier,context,nextResolve){
 if(['./far-terrain-batch','./ground-imagery','./geo','./texture-array-storage'].includes(specifier)&&context.parentURL?.includes('/src/'))return nextResolve(specifier+'.ts',context);
 if(specifier==='./geo'&&[new URL('../src/ground-imagery.ts',import.meta.url).href,new URL('../src/terrain.ts',import.meta.url).href].includes(context.parentURL!))return nextResolve('./geo.ts',context);
 return nextResolve(specifier,context);
}});
const {GroundImagery,groundMipLevels}=await import('../src/ground-imagery.ts');
const {Terrain}=await import('../src/terrain.ts');hooks.deregister();

test('road imagery georeferencing stays below one imagery pixel throughout walking radius',()=>{
 for(const [lat,lon]of [[35.66,139.70],[35.65,139.33],[27.09,142.19]]){
  const frame=new GeoFrame(lat,lon);frame.elevationOffset=36;
  const imagery=new GroundImagery(frame,gpu.renderer);
  try{
   for(const x of [-4700,-700,0,700,4700])for(const z of [-4700,-700,0,700,4700])for(const y of [0,50,400]){
    const geo=frame.toGeo(x,y,z),mapped=imagery.tileAtLocal(x,y,z);
    const tx=(geo.lon+180)/360*2**18,ty=(1-Math.asinh(Math.tan(geo.lat*Math.PI/180))/Math.PI)/2*2**18;
    assert.ok(Math.hypot(mapped.x-tx,mapped.y-ty)*256<.1,'projection error < 0.1 source pixel through rebase distance plus tile radius');
   }
  }finally{imagery.dispose();}
 }
});

test('road texture layer uploads preserve bytes and replacement ownership without allocating new textures',()=>{
 const imagery=new GroundImagery(new GeoFrame(35.66,139.70),gpu.renderer);
 try{
  const x=Math.floor(imagery.base.x),y=Math.floor(imagery.base.y),layer=(y%16)*16+x%16;
  const pixels={width:256,height:256,data:new Uint8ClampedArray(256*256*4)};pixels.data.set([2,3,4,255]);
  imagery.put(x,y,pixels);
  assert.deepEqual([...gpu.pixels(imagery.texture,layer).subarray(0,4)],[2,3,4,255]);
  assert.equal(imagery.texture.image.data,null,'no complete CPU mirror');
  assert.equal(imagery.texture.layerUpdates.size,0);
  assert.equal(imagery.texture.anisotropy,16);
  assert.equal(imagery.texture.generateMipmaps,false,'One tile update never regenerates the complete array mip chain.');
  assert.equal(imagery.owners.image.data[layer*4],0);
  pixels.data.set([8,9,10,255]);imagery.setFocus(x+16,y);imagery.put(x+16,y,pixels);
  assert.equal(imagery.owners.image.data[layer*4],16,'old tile can no longer pass owner check');
  assert.deepEqual([...gpu.pixels(imagery.texture,layer).subarray(0,4)],[8,9,10,255]);
  const material=new MeshBasicMaterial(),shader={uniforms:{},vertexShader:'#include <project_vertex>',fragmentShader:'#include <color_fragment>'} as any;
  imagery.apply(material);material.onBeforeCompile(shader,{} as any);
  assert.equal(shader.uniforms.gsiRoadPhotos.value,imagery.texture);
  assert.ok(shader.vertexShader.includes('modelMatrix*vec4(transformed,1.0)'));
  assert.ok(shader.fragmentShader.includes('vGsiRoadTop>0.65'));
  assert.ok(shader.fragmentShader.includes('abs(gsiOwner-gsiCell)'));
  material.dispose();
 }finally{imagery.dispose();}
});


test('native mip chains retain source bytes and average in linear light',()=>{
 const size=4,data=new Uint8ClampedArray(size*size*4);
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){const c=(x+y)%2?255:0;data.set([c,c,c,255],(y*size+x)*4);}
 const levels=groundMipLevels(data,size);
 assert.equal(levels[0],data,'native base mip is the exact original array');
 assert.deepEqual(levels.map(p=>p.length),[64,16,4]);
 assert.deepEqual([...levels[1].subarray(0,4)],[188,188,188,255],'50% linear light encodes to188sRGB, not a dark128.');
 assert.deepEqual([...levels[2]],[188,188,188,255]);
});

test('high-resolution measured imagery has independent ownership and continuous sampling gradients',()=>{
 const imagery=new GroundImagery(new GeoFrame(35.66,139.7),gpu.renderer);
 try{
  const x=imagery.base.x,y=imagery.base.y,layer=(y%8)*8+x%8,data=new Uint8ClampedArray(512*512*4);data.set([10,20,30,255]);
  imagery.put(x,y,{data,width:512,height:512});
  assert.deepEqual([...gpu.pixels(imagery.detailTexture,layer).subarray(0,4)],[10,20,30,255]);
  assert.equal(imagery.detailOwners.image.data[layer*4],0);assert.equal(imagery.detailTexture.generateMipmaps,false);
  const material=new MeshBasicMaterial(),shader={uniforms:{},vertexShader:'#include <project_vertex>',fragmentShader:'#include <color_fragment>'} as any;
  imagery.apply(material);material.onBeforeCompile(shader,{} as any);
  assert.ok(shader.fragmentShader.includes('dFdx(vGsiRoadTile)'));
  assert.ok(shader.fragmentShader.includes('gsiFiltered(gsiRoadDetails'));
  assert.equal(shader.uniforms.gsiRoadDetails.value,imagery.detailTexture);material.dispose();
 }finally{imagery.dispose();}
});


test('far preload imagery cannot evict camera-window owners at either resolution',()=>{
 const imagery=new GroundImagery(new GeoFrame(35.66,139.70),gpu.renderer);
 try{
  const x=imagery.base.x,y=imagery.base.y;
  for(const size of [256,512]){
   const grid=size===256?16:8,texture=size===256?imagery.texture:imagery.detailTexture,owner=size===256?imagery.owners:imagery.detailOwners;
   const layer=(y%grid)*grid+x%grid,offset=layer*size*1.5*size*4;
   const data=new Uint8ClampedArray(size*size*4);data.set([11,22,33,255]);
   imagery.put(x,y,{data,width:size,height:size});const version=gpu.uploads;
   data.set([99,88,77,255]);imagery.put(x+grid,y,{data,width:size,height:size});imagery.put(x,y-grid,{data,width:size,height:size});
   assert.equal(gpu.uploads,version,'off-window requests perform no GPU upload');
   assert.deepEqual([...gpu.pixels(texture,layer).subarray(0,4)],[11,22,33,255]);
   assert.equal(owner.image.data[layer*4],0);
   assert.equal(owner.image.data[layer*4+1],0);
   assert.equal(imagery.accepts(x-grid/2,y,size),true);
   assert.equal(imagery.accepts(x+grid/2,y,size),false,'window has exactly grid unique coordinates');
  }
 }finally{imagery.dispose();}
});

test('moving away and back restores original base and detailed pixels from loaded terrain chunks',()=>{
 const frame=new GeoFrame(35.66,139.7),imagery=new GroundImagery(frame,gpu.renderer),terrain=new Terrain(frame,new Group(),gpu.renderer,imagery) as any;
 const x=imagery.base.x,y=imagery.base.y;
 const local=(tx:number)=>{const lon=(tx+.5)/2**18*360-180,lat=Math.atan(Math.sinh(Math.PI*(1-2*(y+.5)/2**18)))*180/Math.PI;return frame.toLocal(lat,lon,0);};
 const add=(tx:number,color:number)=>{
  const photo={data:new Uint8ClampedArray(256*256*4),width:256,height:256};photo.data.set([color,2,3,255]);
  const detail=new Uint8ClampedArray(512*512*4);detail.set([color,5,6,255]);
  const map=new DataTexture(detail,512,512),mesh=new Mesh(new BufferGeometry(),new MeshBasicMaterial({map}));
  const key=`${tx}/${y}`;terrain.chunks.set(key,{key,x:tx,y,detail:64,mesh,cellRanges:new Uint32Array(),photo});
  return {photo,detail};
 };
 try{
  const a=add(x,17);add(x+16,61);
  terrain.pump=()=>{};terrain.pumpDetail=()=>{};
  terrain.setPreloadPoints([local(x),local(x+16)]);
  imagery.put(x,y,a.photo);imagery.put(x,y,{data:a.detail,width:512,height:512});
  terrain.update(local(x+16));
  assert.equal(imagery.owners.image.data[((y%16)*16+x%16)*4],16);
  terrain.update(local(x));
  for(const [grid,size,texture]of [[16,256,imagery.texture],[8,512,imagery.detailTexture]] as const){
   const layer=(y%grid)*grid+x%grid;
   assert.equal(gpu.pixels(texture,layer)[0],17,'cached exact source pixels restored after wrap');
  }
  assert.equal(terrain.pixels.size,0,'restoration needs no network pixel cache');
  assert.equal(terrain.wanted.get(`${x-15}/${y}`)?.detail,4,'far terrain extends to fifteen tiles with coarse interiors');
 }finally{terrain.dispose();imagery.dispose();}
});
