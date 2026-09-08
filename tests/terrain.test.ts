import test from 'node:test';
import {recordingRenderer} from './recording-renderer.ts';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Group, LinearMipmapLinearFilter, SRGBColorSpace, Vector3 } from 'three';
import { GeoFrame } from '../src/geo.ts';

const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
 if(['./far-terrain-batch','./ground-imagery','./geo','./texture-array-storage'].includes(specifier)&&context.parentURL?.includes('/src/'))return nextResolve(specifier+'.ts',context);
  if (specifier === './geo' && context.parentURL === new URL('../src/terrain.ts', import.meta.url).href)
    return nextResolve('./geo.ts', context);
  return nextResolve(specifier, context);
} });
const { Terrain } = await import('../src/terrain.ts');
hooks.deregister();
const tileX=232798,tileY=103252;
const fractionalTile=(lat:number,lon:number)=>({x:(lon+180)/360*2**18-tileX,y:(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*2**18-tileY});
const geo=(x:number,y:number,zoom=18)=>({lon:x/2**zoom*360-180,lat:Math.atan(Math.sinh(Math.PI*(1-2*y/2**zoom)))*180/Math.PI});
function fixture() {
  const group = new Group(),frame=new GeoFrame(35.66,139.70);
  const terrain = new Terrain(frame,group,recordingRenderer().renderer) as any;
  const pixels = { width: 256, height: 256, data: new Uint8ClampedArray(256 * 256 * 4) };
  for(let y=0;y<256;y++)for(let x=0;x<256;x++)pixels.data.set([x,y,(x+y)%256,255],(y*256+x)*4);
  terrain.read=async(layer:string)=>layer==='ortho-all'?null:pixels;
  return {terrain,group,pixels,frame};
}
async function build(terrain:any,x=tileX,y=tileY,detail=64){const key=`${x}/${y}`;terrain.wanted.set(key,{detail});await terrain.build(key,x,y,detail);return terrain.chunks.get(key).mesh;}

test('continuous terrain preserves every source image pixel and north-down UV orientation',async()=>{
  const {terrain,group,pixels}=fixture();
  try{
    terrain.elevation=()=>10.123;
    const mesh=await build(terrain),geometry=mesh.geometry,uv=geometry.getAttribute('uv'),position=geometry.getAttribute('position');
    assert.equal(position.count,65*65);assert.equal(geometry.index.count,64*64*6);
    const texture=mesh.material.map;
    assert.equal(texture.image.data,pixels.data,'Full original image bytes remain unchanged.');
    assert.deepEqual([...texture.image.data.subarray(0,4)],[0,0,0,255]);
    assert.deepEqual([...texture.image.data.subarray(-4)],[255,255,254,255]);
    const corners=new Set<string>();
    for(let i=0;i<uv.count;i++){
      if((uv.getX(i)===0||uv.getX(i)===1)&&(uv.getY(i)===0||uv.getY(i)===1))corners.add(`${uv.getX(i)},${uv.getY(i)}`);
      const h=terrain.frame.toGeo(position.getX(i)+mesh.position.x,position.getY(i)+mesh.position.y,position.getZ(i)+mesh.position.z).height;
      assert.ok(Math.abs(h-10.123)<1e-5,'Measured elevation is never quantized to terraces.');
    }
    assert.deepEqual(corners,new Set(['0,0','0,1','1,0','1,1']));
    assert.equal(texture.flipY,false);assert.equal(texture.colorSpace,SRGBColorSpace);
    assert.equal(texture.generateMipmaps,true);assert.equal(texture.minFilter,LinearMipmapLinearFilter);assert.equal(texture.anisotropy,16);
    const disposed={geometry:0,material:0,texture:0};
    geometry.addEventListener('dispose',()=>disposed.geometry++);mesh.material.addEventListener('dispose',()=>disposed.material++);texture.addEventListener('dispose',()=>disposed.texture++);
    terrain.dispose();assert.equal(group.children.length,0);assert.deepEqual(disposed,{geometry:1,material:1,texture:1});
  }finally{terrain.dispose();}
});

test('walking heights match the exact rendered triangles on slopes and both LODs',async()=>{
  const {terrain}=fixture();
  try{
    terrain.elevation=(lat:number,lon:number)=>{const {x,y}=fractionalTile(lat,lon);return 11.137+3*x*x+1.7*y*y+.7*x*y;};
    for(const [x,detail]of [[tileX,64],[tileX+1,16]]){
      const mesh=await build(terrain,x,tileY,detail),position=mesh.geometry.getAttribute('position'),index=mesh.geometry.index;
      for(let n=0;n<index.count;n+=Math.max(3,Math.floor(index.count/80/3)*3)){
        const point=new Vector3();
        for(let k=0;k<3;k++)point.addScaledVector(new Vector3().fromBufferAttribute(position,index.getX(n+k)),[.2,.3,.5][k]);
        point.add(mesh.position);
        const height=terrain.heightAt(point.x,point.z);
        assert.notEqual(height,null);assert.ok(Math.abs(height-point.y)<1e-6,'CPU support equals GPU triangle interpolation.');
      }
    }
  }finally{terrain.dispose();}
});

test('near and far terrain share all edge vertices without cracks, skirts or vertical walls',async()=>{
  const {terrain}=fixture();
  try{
    terrain.elevation=(lat:number,lon:number)=>{const {x,y}=fractionalTile(lat,lon);return 20.123+Math.sin(x*3)*2+Math.sin(y*4)*1.2;};
    const near=await build(terrain),far=await build(terrain,tileX+1,tileY,16);
    const edge=(mesh:any,u:number)=>{
      const uv=mesh.geometry.getAttribute('uv'),p=mesh.geometry.getAttribute('position'),values=new Map<number,Vector3>();
      for(let i=0;i<uv.count;i++)if(uv.getX(i)===u)values.set(uv.getY(i),new Vector3().fromBufferAttribute(p,i).add(mesh.position));
      return values;
    };
    const east=edge(near,1),west=edge(far,0);assert.equal(east.size,65);assert.equal(west.size,65);
    for(const [v,p]of east)assert.ok(p.distanceTo(west.get(v)!)<2e-5,'Both LODs use identical globally sampled edge elevations.');
    for(const mesh of [near,far]){
      const uv=mesh.geometry.getAttribute('uv'),index=mesh.geometry.index;
      for(let n=0;n<index.count;n+=3){
        const a=index.getX(n),b=index.getX(n+1),c=index.getX(n+2);
        const area=Math.abs((uv.getX(b)-uv.getX(a))*(uv.getY(c)-uv.getY(a))-(uv.getX(c)-uv.getX(a))*(uv.getY(b)-uv.getY(a)));
        assert.ok(area>0,'Every triangle is ground surface; no artificial terrace wall or skirt.');
      }
    }
    assert.ok(far.geometry.index.count<near.geometry.index.count/5,'Far LOD retains substantial triangle reduction after edge stitching.');
  }finally{terrain.dispose();}
});

test('DEM bilinear sampling crosses tile boundaries continuously',()=>{
  const {terrain}=fixture();
  try{
    for(const x of [5000,5001])for(const y of [12000,12001]){
      const data=new Uint8ClampedArray(256*256*4);
      for(let j=0;j<256;j++)for(let i=0;i<256;i++){
        const centimeters=10000+(x-5000)*256+i+2*((y-12000)*256+j);
        data.set([centimeters>>16&255,centimeters>>8&255,centimeters&255,255],(j*256+i)*4);
      }
      terrain.dem.set(`dem5a_png/15/${x}/${y}`,{data,width:256,height:256});
    }
    for(const x of [5000.999,5000.999999,5001,5001.000001]){
      const g=geo(x,12000.4,15),actual=terrain.elevation(g.lat,g.lon),expected=100+(x-5000)*256*.01+.4*256*.02;
      assert.ok(Math.abs(actual-expected)<1e-7,'Boundary interpolation uses adjacent tile pixels, not edge clamping.');
    }
  }finally{terrain.dispose();}
});

test('continuous terrain retains no-data holes instead of inventing heights',async()=>{
  const {terrain}=fixture();
  try{
    terrain.elevation=(lat:number,lon:number)=>{const {x,y}=fractionalTile(lat,lon);return x>.75&&y>.75?null:12.123+x*1.5+y*.7;};
    const mesh=await build(terrain,tileX,tileY,16),uv=mesh.geometry.getAttribute('uv'),index=mesh.geometry.index;
    for(let n=0;n<index.count;n++){
      const vertex=index.getX(n);assert.ok(!(uv.getX(vertex)>.75&&uv.getY(vertex)>.75),'No triangle references missing DEM elevation.');
    }
    const g=geo(tileX+.9,tileY+.9),p=terrain.frame.toLocal(g.lat,g.lon,14);
    assert.equal(terrain.heightAt(p.x,p.z),null,'Walking support is absent where the rendered survey has a hole.');
  }finally{terrain.dispose();}
});


test('survey detail upgrade preserves native pixels and GSI fallback at uncovered quadrants',async()=>{
 const {terrain,pixels}=fixture();
 try{
  terrain.elevation=()=>12;const mesh=await build(terrain);
  const measured={width:256,height:256,data:new Uint8ClampedArray(256*256*4)};
  for(let i=0;i<measured.data.length;i+=4)measured.data.set([91,72,53,255],i);
  terrain.read=async(layer:string,z:number,x:number,y:number)=>x===tileX*2&&y===tileY*2?measured:null;
  await terrain.upgradePhoto(`${tileX}/${tileY}`,{x:tileX,y:tileY,mesh,photo:pixels});
  const image=mesh.material.map.image;assert.equal(image.width,512);
  assert.deepEqual([...image.data.subarray(0,4)],[91,72,53,255]);
  const target=(300*512+300)*4,source=(150*256+150)*4;
  assert.deepEqual([...image.data.subarray(target,target+4)],[...pixels.data.subarray(source,source+4)]);
 }finally{terrain.dispose();}
});

test('route preloading keeps a union of locations and a coarse outer terrain horizon',()=>{
 const {terrain,frame}=fixture();
 try{
  terrain.pump=()=>{};terrain.pumpDetail=()=>{};
  const a=new Vector3(-400,50,500),b=new Vector3(300,50,-500);
  terrain.setPreloadPoints([a,b]);terrain.update(a);
  const before=new Set(terrain.wanted.keys());terrain.update(b);
  assert.deepEqual(new Set(terrain.wanted.keys()),before,'Route endpoints remain resident when the camera moves.');
  assert.ok([...terrain.wanted.values()].some((v:any)=>v.detail===8),'Outer horizon uses a cheaper stitched LOD.');
  assert.ok([...terrain.wanted.values()].some((v:any)=>v.detail===64),'Walking neighborhoods retain original near detail.');
 }finally{terrain.dispose();}
});


test('surveyed road conformance follows exact road planes and feathers only outside their footprint',async()=>{
 const {terrain,frame}=fixture();
 try{
  terrain.elevation=()=>12;
  const centerGeo=geo(tileX+.5,tileY+.5),center=frame.toLocal(centerGeo.lat,centerGeo.lon,12);
  const roadHeight=(x:number,z:number)=>18+.025*x+.01*z;
  terrain.setRoadSurfaceProvider((x:number,z:number)=>({height:roadHeight(x,z),distance:Math.max(0,Math.abs(x-center.x)-15)}));
  const mesh=await build(terrain),p=mesh.geometry.getAttribute('position');
  let inside=0,feather=0,outside=0;
  for(let i=0;i<p.count;i++){
   const x=p.getX(i)+mesh.position.x,z=p.getZ(i)+mesh.position.z,y=p.getY(i)+mesh.position.y;
   const distance=Math.max(0,Math.abs(x-center.x)-15),g=frame.toGeo(x,0,z),base=frame.toLocal(g.lat,g.lon,12).y;
   const t=Math.min(1,distance/3),weight=1-t*t*(3-2*t),expected=base+(roadHeight(x,z)-base)*weight;
   assert.ok(Math.abs(y-expected)<2e-4);
   if(distance===0)inside++;else if(distance<3)feather++;else outside++;
  }
  assert.ok(inside&&feather&&outside);assert.equal(mesh.material.toneMapped,true);
 }finally{terrain.dispose();}
});

test('road changes invalidate only intersecting terrain neighborhoods and preserve upgraded imagery',async()=>{
 const {terrain,frame}=fixture();
 try{
  terrain.elevation=()=>12;
  const mesh=await build(terrain);await build(terrain,tileX+5,tileY,8);
  const original=mesh.material.map;original.image={width:512,height:512,data:new Uint8ClampedArray(512*512*4)};
  const g=geo(tileX+.5,tileY+.5),p=frame.toLocal(g.lat,g.lon,12);
  terrain.invalidateRoadBounds(p.x-2,p.z-2,p.x+2,p.z+2);
  assert.deepEqual([...terrain.dirtyRoadChunks],[`${tileX}/${tileY}`]);
  const replacement=await build(terrain);
  assert.equal(replacement.material.map,original);assert.equal(terrain.dirtyRoadChunks.size,0);
 }finally{terrain.dispose();}
});

test('geometry-only rebuilds retain resident photograph bytes and GPU texture ownership',async()=>{
 const {terrain,pixels}=fixture();
 try{
  terrain.elevation=()=>12;
  const first=await build(terrain,tileX,tileY,16),texture=first.material.map;
  let photoRequests=0,textureDisposals=0;
  texture.addEventListener('dispose',()=>textureDisposals++);
  terrain.read=async(layer:string)=>{
   if(layer==='seamlessphoto'){photoRequests++;throw new Error('Resident source photograph should be reused.');}
   return layer==='ortho-all'?null:pixels;
  };
  const second=await build(terrain,tileX,tileY,64);
  assert.equal(photoRequests,0,'Changing LOD needs no photograph refetch or image decode.');
  assert.equal(second.material.map,texture,'The same source image remains uploaded across the geometry replacement.');
  assert.equal(second.material.map.image.data,pixels.data);
  assert.equal(textureDisposals,0,'Releasing the old mesh must not dispose the transferred texture.');
 }finally{terrain.dispose();}
});

test('idle terrain frames do not scan resident tiles or source retry maps',()=>{
 const {terrain}=fixture();
 try{
  // A warm scene may contain thousands of route-preloaded tiles. Iterating any
  // of them on an idle frame is the measured regression this check prevents.
  terrain.wanted[Symbol.iterator]=()=>{throw new Error('Idle resident scan');};
  terrain.chunks[Symbol.iterator]=()=>{throw new Error('Idle chunk scan');};
  terrain.retryAt[Symbol.iterator]=()=>{throw new Error('Retry scan before deadline');};
  for(let frame=0;frame<600;frame++)terrain.pump();
 }finally{
  delete terrain.wanted[Symbol.iterator];delete terrain.chunks[Symbol.iterator];delete terrain.retryAt[Symbol.iterator];terrain.dispose();
 }
});

test('terrain retries wake at their deadline without losing a matching resident tile',async()=>{
 const {terrain}=fixture(),key=`${tileX}/${tileY}`;
 try{
  terrain.elevation=()=>12;await build(terrain,tileX,tileY,16);
  let started=0;
  terrain.build=async()=>{started++;};
  terrain.retry(key,Date.now()+60000);
  for(let frame=0;frame<10;frame++)terrain.pump();
  assert.equal(started,0,'Missing imagery does not retry on every frame.');
  terrain.retry(key,0);terrain.pump();
  assert.equal(started,1,'A due missing-image retry runs even when its geometry is already resident.');
  await new Promise(resolve=>setImmediate(resolve));
  terrain.pump();assert.equal(started,1,'Successful retries return to idle.');
 }finally{terrain.dispose();}
});

test('road updates and changed detail during an in-flight build are retained for the next build',async()=>{
 const {terrain,pixels}=fixture(),key=`${tileX}/${tileY}`;
 try{
  terrain.elevation=()=>12;await build(terrain,tileX,tileY,16);
  const original=terrain.build.bind(terrain),started:number[]=[];
  let finish!:()=>void;const reading=new Promise<void>(resolve=>{finish=resolve;});
  terrain.read=async()=>{await reading;return pixels;};
  terrain.build=(k:string,x:number,y:number,detail:number)=>{started.push(detail);return original(k,x,y,detail);};
  terrain.wanted.set(key,{x:tileX,y:tileY,detail:64});terrain.buildQueue.add(key);terrain.pump();
  assert.deepEqual(started,[64]);
  terrain.wanted.set(key,{x:tileX,y:tileY,detail:16});
  terrain.setRoadSurfaceProvider(()=>null);terrain.pump();
  assert.deepEqual(started,[64],'A second build never overlaps the same source tile.');
  finish();await new Promise(resolve=>setImmediate(resolve));terrain.pump();
  assert.deepEqual(started,[64,16],'The newest requested detail survives the obsolete build finishing.');
  await new Promise(resolve=>setImmediate(resolve));
 }finally{terrain.dispose();}
});
