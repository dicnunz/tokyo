import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import * as THREE from 'three';
import {PreparationBudget,copyTypedArray,copyPositionAttribute,copyTriangleIndices} from '../src/tile-preparation.ts';

// Match the application's bundler resolution while exercising the real class
// and installed TilesRenderer in Node. Third-party module resolution is intact.
const hook=registerHooks({resolve(specifier,context,next){
 if(specifier.startsWith('.')&&context.parentURL?.includes('/src/')&&!/\.[a-z]+$/i.test(specifier))return next(specifier+'.ts',context);
 return next(specifier,context);
}});
const {Buildings}=await import('../src/buildings.ts');
const {indexSourceGeometry}=await import('../src/source-collision.ts');
hook.deregister();

const bytes=(value:ArrayBufferView)=>new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(check:()=>boolean){const started=Date.now();while(!check()){assert.ok(Date.now()-started<3000,'preparation reached the expected state');await turn();}}

test('large typed subviews yield while preserving every bit and leaving source storage intact',async()=>{
 const storage=new Uint32Array(300002);for(let i=0;i<storage.length;i++)storage[i]=(i*1931)^0x80000000;
 storage.set([0x80000000,0x7fc12345,0x7f800000,0xff800000,0x00000001],1);
 const source=new Float32Array(storage.buffer,4,300000),before=bytes(source).slice();
 let time=0,yields=0;const slices:number[]=[];
 const budget=new PreparationBudget(new AbortController().signal,{now:()=>time+=.6,yieldTask:async()=>{yields++;time+=100;},onSlice:ms=>slices.push(ms)});
 const result=await copyTypedArray(source,budget);budget.finish();
 assert.ok(yields>1,'large copies return control to the scheduler');
 assert.notEqual(result.buffer,source.buffer);assert.deepEqual(bytes(result),before);assert.deepEqual(bytes(source),before);
 assert.equal(budget.copiedBytes,source.byteLength);assert.equal(budget.yields,yields);
 assert.ok(Math.max(...slices)<5,'scheduler wait time is excluded from preparation slices');
});

test('interleaved and normalized attributes preserve all collision positions without changing render bytes',async()=>{
 const original=new Int16Array([90,-32767,0,32767,91,16384,-16384,0]);
 const attribute=new THREE.InterleavedBufferAttribute(new THREE.InterleavedBuffer(original,4),3,1,true);
 const before=bytes(original).slice(),budget=new PreparationBudget(new AbortController().signal);
 const result=await copyPositionAttribute(attribute,budget);
 assert.deepEqual(result,new Float32Array([-1,0,1,16384/32767,-16384/32767,0]));
 assert.deepEqual(bytes(original),before);assert.equal(attribute.data.array,original);
});

test('indexed and unindexed collision copies preserve every triangle and source ordering',async()=>{
 const source=new Uint16Array(90000);for(let i=0;i<source.length;i++)source[i]=(i*79)%65536;
 const original=source.slice(),budget=new PreparationBudget(new AbortController().signal);
 const indices=await copyTriangleIndices(new THREE.BufferAttribute(source,1),0,budget);
 assert.deepEqual(indices,new Uint32Array(original));assert.deepEqual(source,original);
 const unindexed=await copyTriangleIndices(null,90000,budget);
 assert.equal(unindexed.length,90000);for(let i=0;i<unindexed.length;i++)assert.equal(unindexed[i],i);
});

test('cancellation at a copy yield stops further copying and never alters source data',async()=>{
 const source=new Uint32Array(1024*1024).fill(0xfedcba98),before=source.slice(),controller=new AbortController();let time=0;
 const budget=new PreparationBudget(controller.signal,{now:()=>time+=1,yieldTask:async()=>controller.abort()});
 await assert.rejects(copyTypedArray(source,budget),{name:'AbortError'});
 assert.ok(budget.copiedBytes<source.byteLength);assert.deepEqual(source,before);
 let started=false;await assert.rejects(budget.wait(async()=>{started=true;}),{name:'AbortError'});assert.equal(started,false);
});

class CollisionWorker{
 static latest:CollisionWorker;
 onmessage?:({data}:any)=>void;onerror?:({message}:any)=>void;
 messages:any[]=[];terminated=false;
 constructor(){CollisionWorker.latest=this;}
 postMessage(data:any,transfer:ArrayBuffer[]){this.messages.push(structuredClone(data,{transfer}));}
 complete(){const message=this.messages.shift();this.onmessage?.({data:{id:message.id,result:indexSourceGeometry(message.chunks)}});}
 terminate(){this.terminated=true;}
}

function fixture(t:any){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'Worker');
 Object.defineProperty(globalThis,'Worker',{value:CollisionWorker,configurable:true});
 let buildings:InstanceType<typeof Buildings>;
 try{
  const frame={ecefToLocal:new THREE.Matrix4(),localToEcef:new THREE.Matrix4()};
  const renderer={extensions:{has:()=>false},capabilities:{getMaxAnisotropy:()=>16},getSize:(v:THREE.Vector2)=>v.set(800,600),getDrawingBufferSize:(v:THREE.Vector2)=>v.set(800,600)};
  buildings=new Buildings(frame as any,new THREE.Group(),new THREE.PerspectiveCamera(65,4/3,.25,1800),renderer as any);
 }finally{if(previous)Object.defineProperty(globalThis,'Worker',previous);else delete(globalThis as any).Worker;}
 t.after(()=>buildings.dispose());
 const model=new THREE.Group(),geometry=new THREE.BoxGeometry(4,4,.1);geometry.translate(0,2,0);
 const pixels=new Uint8Array([12,43,99,255,255,7,33,255,0,200,60,255,81,82,83,255]),map=new THREE.DataTexture(pixels,2,2);
 map.offset.set(.13,.29);map.repeat.set(2,3);map.rotation=.17;
 const materials=Array.from({length:6},(_,i)=>new THREE.MeshStandardMaterial({map,color:new THREE.Color(.17+i*.07,.39,.81)}));
 const mesh=new THREE.Mesh(geometry,materials);mesh.position.set(.25,0,.1);model.add(mesh);
 const tile={_kind:'buildings',parent:null,engineData:{transform:new THREE.Matrix4(),scene:null as THREE.Object3D|null}};
 buildings.tiles.registerPlugin({name:'PREPARATION_FIXTURE',parseToMesh:()=>model});
 const plugin=(buildings.tiles as any).getPluginByName('ORIGINAL_SURVEY_GEOMETRY');
 const parse=(signal:AbortSignal)=>(buildings.tiles as any).invokeOnePlugin((p:any)=>p.parseTile?.(new TextEncoder().encode('test').buffer,tile,'test','https://assets.cms.plateau.reearth.io/test.glb',signal)) as Promise<void>;
 return{buildings,worker:CollisionWorker.latest,model,geometry,pixels,map,materials,tile,plugin,parse};
}

test('installed parser publishes the real model only after collision is ready, retaining render bytes and groups',async t=>{
 const f=fixture(t),positions=f.geometry.getAttribute('position'),uv=f.geometry.getAttribute('uv'),index=f.geometry.index!;
 const positionBytes=bytes(positions.array).slice(),uvBytes=bytes(uv.array).slice(),indexBytes=bytes(index.array).slice(),pixels=f.pixels.slice(),colors=f.materials.map(m=>m.color.toArray());
 const pending=f.parse(new AbortController().signal);await until(()=>f.worker.messages.length===1);
 assert.equal(f.tile.engineData.scene,null,'a visible scene cannot be published while its collision worker is pending');
 assert.equal(f.buildings.pending,1);assert.equal(f.buildings.stats.visible,0);
 const chunks=f.worker.messages[0].chunks;assert.equal(chunks.length,1);assert.equal(chunks[0].indices.length,index.count);
 assert.deepEqual(chunks[0].indices,new Uint32Array(index.array));
 f.worker.complete();await pending;
 assert.equal(f.tile.engineData.scene,f.model);assert.equal(f.buildings.pending,0);assert.ok(f.buildings.entries.get(f.tile)?.collision);
 const parts:THREE.Mesh[]=[];f.model.traverse(o=>{if((o as THREE.Mesh).isMesh)parts.push(o as THREE.Mesh);});
 assert.equal(parts.length,6);
 for(let i=0;i<parts.length;i++){
  const part=parts[i];assert.equal(part.geometry.getAttribute('position'),positions);assert.equal(part.geometry.getAttribute('uv'),uv);assert.equal(part.geometry.index,index);
  assert.deepEqual(part.geometry.drawRange,{start:i*6,count:6});assert.equal((part.material as THREE.MeshBasicMaterial).map,f.map);
  assert.deepEqual((part.material as THREE.MeshBasicMaterial).color.toArray(),colors[i]);
 }
 assert.deepEqual(bytes(positions.array),positionBytes);assert.deepEqual(bytes(uv.array),uvBytes);assert.deepEqual(bytes(index.array),indexBytes);assert.deepEqual(f.pixels,pixels);
 assert.deepEqual(f.map.offset.toArray(),[.13,.29]);assert.deepEqual(f.map.repeat.toArray(),[2,3]);assert.equal(f.map.rotation,.17);
 (f.buildings.tiles as any).dispatchEvent({type:'tile-visibility-change',tile:f.tile,visible:true});
 assert.equal(f.buildings.blocked(.25,.1,0),true,'the first visible frame already has working wall collision');
});

test('frozen source nodes retain their transforms and collision follows the tile georeferencing',async t=>{
 const f=fixture(t);f.model.updateMatrixWorld(true);f.model.traverse(node=>{node.matrixAutoUpdate=false;node.matrixWorldNeedsUpdate=false;});
 const sourceMatrix=f.model.children[0].matrix.clone();f.tile.engineData.transform.makeTranslation(100,10,-75);
 const pending=f.parse(new AbortController().signal);await until(()=>f.worker.messages.length===1);
 const matrix=f.worker.messages[0].chunks[0].matrix;assert.deepEqual(matrix.slice(12,15),[100.25,10,-74.9]);
 f.worker.complete();await pending;
 assert.deepEqual(f.model.children[0].matrix.elements,sourceMatrix.elements);
 (f.buildings.tiles as any).dispatchEvent({type:'tile-visibility-change',tile:f.tile,visible:true});
 assert.equal(f.buildings.blocked(100.25,-74.9,10),true);assert.equal(f.buildings.blocked(.25,.1,0),false);
});

for(const cancellation of ['request','tile','session'] as const)test(`${cancellation} disposal during collision preparation prevents later publication`,async t=>{
 const f=fixture(t),controller=new AbortController();let textureDisposals=0;f.map.addEventListener('dispose',()=>textureDisposals++);
 const pending=f.parse(controller.signal),rejected=assert.rejects(pending,{name:'AbortError'});await until(()=>f.worker.messages.length===1);
 if(cancellation==='request')controller.abort();else if(cancellation==='tile')f.plugin.disposeTile(f.tile);else f.buildings.dispose();
 await rejected;assert.equal(f.tile.engineData.scene,null);assert.equal(f.buildings.entries.size,0);assert.equal(f.buildings.pending,0);assert.equal(f.buildings.cells,0);assert.equal(textureDisposals,1);
 f.worker.complete();await turn();assert.equal(f.tile.engineData.scene,null);assert.equal(f.buildings.entries.size,0);assert.equal(f.buildings.cells,0);
});
