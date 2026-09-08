import test from 'node:test';
import {recordingRenderer} from './recording-renderer.ts';
const gpu=recordingRenderer();
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {Group,Mesh,MeshBasicMaterial,BufferGeometry,Float32BufferAttribute,DataTexture} from 'three';
const hooks=registerHooks({resolve(specifier,context,nextResolve){if(['./ground-imagery','./geo','./texture-array-storage'].includes(specifier)&&context.parentURL?.includes('/src/'))return nextResolve(specifier+'.ts',context);return nextResolve(specifier,context);}});
const {FarTerrainBatch}=await import('../src/far-terrain-batch.ts');hooks.deregister();
function source(x:number,y:number,color:number){
 const data=new Uint8ClampedArray(256*256*4);for(let row=0;row<256;row++)for(let col=0;col<256;col++)data.set([color,row,col,255],(row*256+col)*4);
 const photo={data,width:256,height:256},geometry=new BufferGeometry();geometry.setAttribute('position',new Float32BufferAttribute([0,2.25,0,0,3.25,10,10,4.25,10,10,3.25,0],3));geometry.setAttribute('uv',new Float32BufferAttribute([0,0,0,1,1,1,1,0],2));geometry.setIndex([0,1,2,0,2,3]);
 const mesh=new Mesh(geometry,new MeshBasicMaterial({map:new DataTexture(data,256,256)}));mesh.position.set(x*10,0,y*10);return{mesh,photo};
}

test('far page batching retains every source triangle, position, UV and source photograph',async()=>{
 const group=new Group(),batch=new FarTerrainBatch(group,gpu.renderer),a=source(8,16,21),b=source(9,16,63);group.add(a.mesh,b.mesh);
 const originalA=[...a.mesh.geometry.getAttribute('position').array];
 try{
  batch.upsert('a',8,16,a.mesh,a.photo);batch.upsert('b',9,16,b.mesh,b.photo);await batch.flush();
  const merged=group.children.find(o=>o.userData.farTerrainBatch) as Mesh;
  assert.ok(merged);assert.equal(group.children.filter(o=>o.visible).length,1,'two far draw calls become one');
  assert.equal(a.mesh.visible,false);assert.equal(b.mesh.visible,false);
  assert.deepEqual([...a.mesh.geometry.getAttribute('position').array],originalA,'walking/export geometry is unchanged');
  assert.equal(merged.geometry.index!.count,12);assert.deepEqual([...merged.geometry.index!.array],[0,1,2,0,2,3,4,5,6,4,6,7]);
  const p=merged.geometry.getAttribute('position'),uv=merged.geometry.getAttribute('uv');
  for(const [number,original]of [a.mesh,b.mesh].entries())for(let i=0;i<4;i++){
   const op=original.geometry.getAttribute('position'),ou=original.geometry.getAttribute('uv');
   assert.equal(p.getX(number*4+i)+merged.position.x,op.getX(i)+original.position.x);
   assert.equal(p.getY(number*4+i)+merged.position.y,op.getY(i)+original.position.y);
   assert.equal(p.getZ(number*4+i)+merged.position.z,op.getZ(i)+original.position.z);
   assert.equal(uv.getX(number*4+i),ou.getX(i));assert.equal(uv.getY(number*4+i),ou.getY(i));
  }
  const shader={uniforms:{},vertexShader:'#include <uv_vertex>',fragmentShader:'#include <map_fragment>'}as any;
  (merged.material as MeshBasicMaterial).onBeforeCompile(shader,{}as any);const texture=shader.uniforms.farPhotos.value;
  assert.equal(texture.generateMipmaps,false);
  for(const [layer,photo]of [[0,a.photo],[1,b.photo]]as const)for(let row=0;row<256;row++)assert.deepEqual(Buffer.from(gpu.pixels(texture,layer).subarray(row*256*4,(row+1)*256*4)),Buffer.from(photo.data.subarray(row*256*4,(row+1)*256*4)));
  batch.remove('a');assert.equal(shader.uniforms.farActive.value[0],0,'removed layer disappears immediately before rebuild');await batch.flush();assert.equal(merged.geometry.index!.count,6);
  let disposed=0;texture.addEventListener('dispose',()=>disposed++);batch.remove('b');assert.equal(group.children.some(o=>o.userData.farTerrainBatch),false);assert.equal(disposed,1,'empty page releases its GPU texture');
 }finally{batch.dispose();for(const s of [a,b]){s.mesh.geometry.dispose();(s.mesh.material as MeshBasicMaterial).map?.dispose();(s.mesh.material as MeshBasicMaterial).dispose();}}
});

test('distant geographic coordinates share densely occupied physical pages without aliasing',async()=>{
 const group=new Group(),batch=new FarTerrainBatch(group,gpu.renderer),a=source(0,0,4),b=source(8,0,8);group.add(a.mesh,b.mesh);
 try{batch.upsert('a',0,0,a.mesh,a.photo);batch.upsert('b',8,0,b.mesh,b.photo);await batch.flush();assert.equal(batch.stats.pages,1);assert.equal(batch.stats.capacity,64);assert.equal(group.children.filter(o=>o.userData.farTerrainBatch).length,1);batch.remove('a');assert.equal(batch.stats.pages,1);assert.equal(b.mesh.visible,false);}
 finally{batch.dispose();for(const s of [a,b]){s.mesh.geometry.dispose();(s.mesh.material as MeshBasicMaterial).map?.dispose();(s.mesh.material as MeshBasicMaterial).dispose();}}
});

test('physical slots are reused safely during an asynchronous batch replacement',async()=>{
 const group=new Group(),batch=new FarTerrainBatch(group,gpu.renderer),sources=Array.from({length:65},(_,i)=>source(i*8,i*16,i));
 try{
  for(let i=0;i<64;i++){const s=sources[i];group.add(s.mesh);batch.upsert(String(i),i*8,i*16,s.mesh,s.photo);}
  assert.equal(batch.stats.pages,1,'64 distant tiles fill one array instead of 64 geographic arrays');
  batch.update();
  batch.remove('0');const replacement=sources[64];group.add(replacement.mesh);batch.upsert('replacement',512,1024,replacement.mesh,replacement.photo);
  await batch.flush();
  assert.equal(batch.stats.pages,1,'freed physical layer is reused before allocating storage');
  assert.equal(batch.stats.textureCpuBytes,0);
  const merged=group.children.find(o=>o.userData.farTerrainBatch)as Mesh;
  assert.equal(merged.geometry.index!.count,64*6,'no stale or missing source triangles after replacement');
  const shader={uniforms:{},vertexShader:'#include <uv_vertex>',fragmentShader:'#include <map_fragment>'}as any;
  (merged.material as MeshBasicMaterial).onBeforeCompile(shader,{}as any);
  const texture=shader.uniforms.farPhotos.value;
  assert.equal(gpu.pixels(texture,0)[0],64,'the removed photograph cannot reappear in its reused slot');
  assert.equal(texture.image.data,null);assert.equal(texture.mipmaps.length,9);assert.equal(texture.anisotropy,16);
  assert.equal(replacement.mesh.visible,false);
 }finally{batch.dispose();for(const s of sources){s.mesh.geometry.dispose();(s.mesh.material as MeshBasicMaterial).map?.dispose();(s.mesh.material as MeshBasicMaterial).dispose();}}
});

test('far batching preserves a detailed survey photograph and every native mip level',async()=>{
 const group=new Group(),batch=new FarTerrainBatch(group,gpu.renderer),a=source(0,0,4);
 const data=new Uint8ClampedArray(512*512*4);data.set([17,83,231,255]);data.set([93,41,7,255],data.length-4);
 try{
  group.add(a.mesh);batch.upsert('a',0,0,a.mesh,a.photo);await batch.flush();
  batch.upsert('a',0,0,a.mesh,{data,width:512,height:512});await batch.flush();
  const merged=group.children.find(o=>o.userData.farTerrainBatch)as Mesh;
  const shader={uniforms:{},vertexShader:'#include <uv_vertex>',fragmentShader:'#include <map_fragment>'}as any;
  (merged.material as MeshBasicMaterial).onBeforeCompile(shader,{}as any);const texture=shader.uniforms.farPhotos.value;
  assert.equal(batch.stats.pages,1);assert.equal(batch.stats.detailedTiles,1);assert.equal(batch.stats.capacity,16);
  assert.equal(texture.image.width,512);assert.equal(texture.mipmaps.length,10);
  assert.deepEqual(gpu.pixels(texture,0),Uint8Array.from(data),'the complete higher resolution source survives the LOD boundary');
  assert.equal(gpu.pixels(texture,0,9).length,4);
 }finally{batch.dispose();a.mesh.geometry.dispose();(a.mesh.material as MeshBasicMaterial).map?.dispose();(a.mesh.material as MeshBasicMaterial).dispose();}
});
