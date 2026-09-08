import * as THREE from 'three';
import {TilesRenderer} from '3d-tiles-renderer/three';
import {LoadRegionPlugin,SphereRegion,GLTFExtensionsPlugin} from '3d-tiles-renderer/three/plugins';
import {DRACOLoader} from 'three/addons/loaders/DRACOLoader.js';
import {GeoFrame} from './geo';
import {CollisionIndexer,type CollisionChunk,type SourceCollision} from './source-collision';
import type {GroundImagery} from './ground-imagery';
import {createTextureLoader,installCompressedTiles} from './compressed-tiles';
import {PreparationBudget,copyPositionAttribute,copyTriangleIndices} from './tile-preparation';
export const BUILDING_URL='/tokyo-tileset.json';
type Entry={collision?:SourceCollision;visible:boolean;disposed:boolean;registered:boolean;textures:number;texturedTriangles:number;triangles:number};
/** Original indexed survey meshes. No voxel conversion, projection, or mesh cache. */
export class Buildings{
 tiles:TilesRenderer;region:SphereRegion;entries=new Map<any,Entry>();pending=0;completed=0;errors=0;cells=0;disposed=false;settled=false;lastError='';
 onGroundRoadBoundsChanged?: (minX:number,minZ:number,maxX:number,maxZ:number)=>void;
 private collisionSpatial=new Map<string,Set<Entry>>();private groundSpatial=new Map<string,Set<Entry>>();private groundCandidates=new Set<Entry>();
 private preparationSignals=new WeakMap<object,AbortSignal>();private preparations=new Map<object,AbortController>();private preparationSession=new AbortController();
 private preparationMaxSliceMs=0;private preparationYields=0;private preparationCopiedBytes=0;private preparationCancelled=0;
 private indexer=new CollisionIndexer();private lastUpdate=-Infinity;private lastRetry=0;private regionPlugin=new LoadRegionPlugin();private preload:SphereRegion[]=[];private pixels=700;private horizon:SphereRegion;private viewRegion:SphereRegion;
 constructor(public frame:GeoFrame,group:THREE.Group,camera:THREE.Camera,renderer:THREE.WebGLRenderer,imagery?:GroundImagery){
  this.tiles=new TilesRenderer(BUILDING_URL);const draco=new DRACOLoader();draco.setDecoderPath('/draco/');draco.setWorkerLimit(2);this.tiles.registerPlugin(new GLTFExtensionsPlugin({dracoLoader:draco,ktxLoader:createTextureLoader(renderer)}));
  installCompressedTiles(this.tiles,renderer);this.tiles.group.matrixAutoUpdate=false;this.tiles.group.matrix.copy(frame.ecefToLocal);group.add(this.tiles.group);this.tiles.setCamera(camera);this.tiles.setResolutionFromRenderer(camera,renderer);this.tiles.errorTarget=18;
  this.tiles.autoDisableRendererCulling=false;this.tiles.loadSiblings=false;this.tiles.loadAncestors=false;
  this.tiles.downloadQueue.maxJobsPerOrigin=3;this.tiles.parseQueue.maxJobs=1;this.tiles.maxTilesProcessed=50;this.tiles.processNodeQueue.maxJobs=2;
  this.tiles.lruCache.maxSize=1000;this.tiles.lruCache.minSize=700;this.tiles.lruCache.maxBytesSize=4096*1048576;this.tiles.lruCache.minBytesSize=3072*1048576;
  this.region=this.makeRegion(new THREE.Vector3(),150,0);this.regionPlugin.addRegion(this.region);this.viewRegion=this.makeRegion(new THREE.Vector3(),550,0,false,true);this.regionPlugin.addRegion(this.viewRegion);this.horizon=this.makeRegion(new THREE.Vector3(),1800,10000,true,true);this.regionPlugin.addRegion(this.horizon);this.tiles.registerPlugin(this.regionPlugin);this.resize(camera,renderer);
  const anisotropy=Math.min(16,renderer.capabilities.getMaxAnisotropy());
  this.tiles.registerPlugin({name:'ORIGINAL_SURVEY_GEOMETRY',
   // This observes the same request signal as the installed parser. Returning
   // null lets its normal b3dm/GLB parser and extension plugins handle the data.
   parseTile:(_buffer:ArrayBuffer,tile:any,_extension:string,_url:string,signal:AbortSignal)=>{this.preparationSignals.set(tile,signal);return null;},
   processTileModel:(model:THREE.Object3D,tile:any)=>this.prepareModel(model,tile,anisotropy,imagery),
   disposeTile:(tile:any)=>{this.preparations.get(tile)?.abort();this.removeEntry(tile);},
  });
  this.tiles.addEventListener('tile-visibility-change',(e:any)=>{const entry=this.entries.get(e.tile);if(entry){entry.visible=e.visible;const b=entry.collision?.data.groundBounds;if(b)this.onGroundRoadBoundsChanged?.(b[0],b[1],b[2],b[3]);}});
  this.tiles.addEventListener('dispose-model',(e:any)=>this.removeEntry(e.tile));
  this.tiles.addEventListener('tiles-load-start',()=>{this.settled=false;});this.tiles.addEventListener('tiles-load-end',()=>{this.settled=true;if(!(this.tiles as any).stats.failed){this.errors=0;this.lastError='';}});
  this.tiles.addEventListener('load-error',(e:any)=>{if(this.disposed)return;this.errors++;this.lastError=String(e.error?.message??e.error);});
 }
 private async prepareModel(model:THREE.Object3D,tile:any,anisotropy:number,imagery?:GroundImagery){
  const controller=new AbortController(),requestSignal=this.preparationSignals.get(tile);
  const signal=AbortSignal.any([controller.signal,this.preparationSession.signal,...(requestSignal?[requestSignal]:[])]);
  const budget=new PreparationBudget(signal,{onSlice:ms=>{this.preparationMaxSliceMs=Math.max(this.preparationMaxSliceMs,ms);}});
  const entry:Entry={visible:false,disposed:false,registered:false,textures:0,texturedTriangles:0,triangles:0};
  const oldMaterials=new Set<THREE.Material>(),converted=new Map<THREE.Material,THREE.MeshBasicMaterial>(),extraGeometry=new Set<THREE.BufferGeometry>();
  this.preparations.set(tile,controller);this.entries.set(tile,entry);this.pending++;
  try{
   budget.check();let kind='buildings';for(let n=tile;n;n=n.parent)if(n._kind){kind=n._kind;break;}
   const meshes:THREE.Mesh[]=[],nodes=[model];
   while(nodes.length){const node=nodes.pop()!;node.updateWorldMatrix(false,false,true);if((node as THREE.Mesh).isMesh)meshes.push(node as THREE.Mesh);for(let i=node.children.length-1;i>=0;i--)nodes.push(node.children[i]);const pause=budget.checkpoint();if(pause)await pause;}
   const table=(model as any).batchTable;let sections:any[]=[],attributes:any[]=[];
   if(kind==='roads'&&table){try{sections=table.getPropertyArray('uro:RoadStructureAttribute_uro:sectionType')??[];}catch{}try{attributes=table.getPropertyArray('attributes')??[];}catch{}}
   const atGrade=new Map<number,boolean>();
   const isAtGrade=(id:number)=>{if(atGrade.has(id))return atGrade.get(id)!;let accept=false;
    if(sections[id]!=null)accept=sections[id]==='土工区間';
    else{const codes:string[]=[];const visit=(v:any)=>{if(!v||typeof v!=='object')return;for(const[key,value]of Object.entries(v)){if(key==='uro:sectionType_code')codes.push(String(value));else if(typeof value==='object')visit(value);}};visit(attributes[id]);accept=codes.includes('1')&&!codes.some(c=>c!=='1');}
    atGrade.set(id,accept);return accept;};
   const chunks:CollisionChunk[]=[],maps=new Set<THREE.Texture>();
   const materialFor=(source:THREE.Material)=>{
    if(converted.has(source))return converted.get(source)!;oldMaterials.add(source);const original=source as THREE.MeshStandardMaterial,map=original.map??null;
    if(map){map.anisotropy=anisotropy;maps.add(map);}
    const material=new THREE.MeshBasicMaterial({map,color:original.color?.clone()??new THREE.Color(0xc6cbc5),side:original.side,opacity:original.opacity,transparent:original.transparent,alphaTest:original.alphaTest,depthWrite:original.depthWrite,vertexColors:original.vertexColors,toneMapped:true});
    if(['roads','bridges','paths','street-furniture'].includes(kind)){material.polygonOffset=true;material.polygonOffsetFactor=kind==='street-furniture'?-2:-1;material.polygonOffsetUnits=kind==='street-furniture'?-2:-1;}
    if(!map&&['buildings','roads','bridges','paths'].includes(kind))imagery?.apply(material);converted.set(source,material);return material;
   };
   for(const mesh of meshes){
    const geometry=mesh.geometry,p=geometry.getAttribute('position');if(!p)continue;
    // Chunked copies belong only to collision. Render data keeps every original
    // attribute, index, UV, transform, color, and photographic texture reference.
    const positions=await copyPositionAttribute(p,budget),index=await copyTriangleIndices(geometry.index,p.count,budget);budget.check();
    let groundTriangles:Uint32Array|undefined;
    if(kind==='roads'&&table){const batch=geometry.getAttribute('_batchid')??geometry.getAttribute('_BATCHID');if(batch){
     const ground=new Uint32Array(Math.floor(index.length/3));let count=0;
     for(let start=0;start<index.length;start+=3*256){const end=Math.min(index.length,start+3*256);for(let t=start;t<end;t+=3)if(isAtGrade(Math.round(batch.getX(index[t]))))ground[count++]=t/3;const pause=budget.checkpoint();if(pause)await pause;}
     groundTriangles=ground.subarray(0,count);
    }}
    chunks.push({positions,indices:index,groundTriangles,matrix:new THREE.Matrix4().multiplyMatrices(this.frame.ecefToLocal,mesh.matrixWorld).toArray()});entry.triangles+=index.length/3;
    if(Array.isArray(mesh.material)){
     // Scalar-material parts share the untouched source index attribute. Draw
     // ranges select their original groups without allocating another mesh copy.
     const replacement=new THREE.Group();replacement.name=mesh.name;replacement.matrix.copy(mesh.matrix);replacement.matrix.decompose(replacement.position,replacement.quaternion,replacement.scale);replacement.matrixAutoUpdate=false;
     for(const g of geometry.groups.length?geometry.groups:[{start:0,count:index.length,materialIndex:0}]){
      const source=mesh.material[g.materialIndex??0],material=materialFor(source),part=new THREE.BufferGeometry();extraGeometry.add(part);
      for(const name in geometry.attributes)part.setAttribute(name,geometry.attributes[name]);part.setIndex(geometry.index);part.morphAttributes=geometry.morphAttributes;part.morphTargetsRelative=geometry.morphTargetsRelative;
      const start=Math.max(g.start,geometry.drawRange.start),end=Math.min(g.start+g.count,geometry.drawRange.start+geometry.drawRange.count);part.setDrawRange(start,Math.max(0,end-start));
      part.boundingBox=geometry.boundingBox?.clone()??null;part.boundingSphere=geometry.boundingSphere?.clone()??null;
      const child=new THREE.Mesh(part,material);child.matrixAutoUpdate=false;replacement.add(child);if(material.map)entry.texturedTriangles+=g.count/3;
      const pause=budget.checkpoint();if(pause)await pause;
     }
     for(const child of [...mesh.children])replacement.add(child);mesh.parent?.add(replacement);mesh.removeFromParent();geometry.dispose();
    }else{mesh.material=materialFor(mesh.material);if((mesh.material as THREE.MeshBasicMaterial).map)entry.texturedTriangles+=index.length/3;mesh.matrixAutoUpdate=false;}
    const pause=budget.checkpoint();if(pause)await pause;
   }
   for(const material of oldMaterials){for(const value of Object.values(material))if((value as THREE.Texture)?.isTexture&&!maps.has(value as THREE.Texture))(value as THREE.Texture).dispose();material.dispose();const pause=budget.checkpoint();if(pause)await pause;}
   model.matrixAutoUpdate=false;entry.textures=maps.size;
   // TilesRenderer awaits this plugin before assigning engineData.scene or
   // marking the tile LOADED. A replacement cannot become visible prematurely.
   entry.collision=await budget.wait(()=>this.indexer.index(chunks));
   await this.registerSpatial(entry,budget);budget.check();entry.registered=true;
   this.cells+=entry.collision.buckets.size;this.completed++;
   const b=entry.collision.data.groundBounds;if(b)this.onGroundRoadBoundsChanged?.(b[0],b[1],b[2],b[3]);
  }catch(error){
   if(signal.aborted)this.preparationCancelled++;
   this.removeEntry(tile,entry);this.releasePreparingModel(model,oldMaterials,converted.values(),extraGeometry);throw error;
  }finally{
   budget.finish();this.preparationYields+=budget.yields;this.preparationCopiedBytes+=budget.copiedBytes;this.pending--;
   if(this.preparations.get(tile)===controller)this.preparations.delete(tile);
  }
 }
 private releasePreparingModel(model:THREE.Object3D,oldMaterials:Set<THREE.Material>,converted:Iterable<THREE.Material>,geometry:Set<THREE.BufferGeometry>){
  const materials=new Set([...oldMaterials,...converted]),textures=new Set<THREE.Texture>(),images=new Set<ImageBitmap>();
  model.traverse(object=>{const mesh=object as THREE.Mesh;if(mesh.geometry)geometry.add(mesh.geometry);if(mesh.material)for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material])materials.add(material);});
  for(const material of materials){for(const value of Object.values(material))if((value as THREE.Texture)?.isTexture)textures.add(value as THREE.Texture);material.dispose();}
  for(const item of geometry)item.dispose();
  for(const texture of textures){if(typeof ImageBitmap!=='undefined'&&texture.image instanceof ImageBitmap)images.add(texture.image);texture.dispose();}
  for(const image of images)image.close();
 }
 private removeEntry(tile:any,entry=this.entries.get(tile)){
  if(!entry||entry.disposed)return;entry.disposed=true;entry.visible=false;this.unregisterSpatial(entry);
  if(entry.registered)this.cells-=entry.collision?.buckets.size??0;
  if(this.entries.get(tile)===entry)this.entries.delete(tile);
  const b=entry.collision?.data.groundBounds;if(b)this.onGroundRoadBoundsChanged?.(b[0],b[1],b[2],b[3]);
 }
 private makeRegion(position:THREE.Vector3,radius:number,bias:number,buildingsOnly=false,viewOnly=false){
  const region=new SphereRegion({sphere:new THREE.Sphere(position.clone().applyMatrix4(this.frame.localToEcef),radius),mask:true});
  if(buildingsOnly||viewOnly)(region as any).intersectsTile=(volume:any,tile:any)=>{if(buildingsOnly)for(let n=tile;n;n=n.parent)if(n._kind&&n._kind!=='buildings')return false;const frustum=(this.tiles as any).cameraInfo?.[0]?.frustum;return volume.intersectsSphere(region.sphere)&&(!viewOnly||!frustum||volume.intersectsFrustum(frustum));};
  (region as any).calculateDistance=(volume:any)=>volume.distanceToPoint(region.sphere.center);
  // Match perspective screen-space error instead of forcing every tile to leaf LOD.
  (region as any).calculateError=(tile:any)=>tile.geometricError*this.pixels/Math.max(8,tile.engineData.boundingVolume.distanceToPoint(region.sphere.center)+bias);
  return region;
 }
 setPreloadPoints(points:THREE.Vector3[],radius=140,bias=220){this.clearPreloadPoints();for(const point of points.slice(0,12)){const region=this.makeRegion(point,radius,bias);this.preload.push(region);this.regionPlugin.addRegion(region);}this.lastUpdate=-Infinity;}
 clearPreloadPoints(){for(const region of this.preload)this.regionPlugin.removeRegion(region);this.preload=[];this.lastUpdate=-Infinity;}
 update(position:THREE.Vector3){const now=performance.now();if(now-this.lastUpdate<50)return;this.lastUpdate=now;this.region.sphere.center.copy(position).applyMatrix4(this.frame.localToEcef);this.horizon.sphere.center.copy(this.region.sphere.center);this.viewRegion.sphere.center.copy(this.region.sphere.center);this.tiles.group.updateMatrixWorld();this.tiles.update();if(this.errors&&now-this.lastRetry>15000){this.lastRetry=now;this.tiles.resetFailedTiles();}}
 resize(camera:THREE.Camera,renderer:THREE.WebGLRenderer){this.tiles.setResolutionFromRenderer(camera,renderer);const size=renderer.getDrawingBufferSize(new THREE.Vector2()),fov=(camera as THREE.PerspectiveCamera).fov??65;this.pixels=size.y/(2*Math.tan(THREE.MathUtils.degToRad(fov/2)));this.lastUpdate=-Infinity;}
 private async registerSpatial(entry:Entry,budget:PreparationBudget){let count=0;for(const [map,buckets]of [[this.collisionSpatial,entry.collision!.buckets],[this.groundSpatial,entry.collision!.data.groundBuckets]] as const)for(const key of buckets?.keys()??[]){let values=map.get(key);if(!values){values=new Set();map.set(key,values);}values.add(entry);if(++count%64===0){const pause=budget.checkpoint();if(pause)await pause;}}}
 private unregisterSpatial(entry:Entry){for(const [map,buckets]of [[this.collisionSpatial,entry.collision?.buckets],[this.groundSpatial,entry.collision?.data.groundBuckets]] as const)for(const key of buckets?.keys()??[]){const values=map.get(key);values?.delete(entry);if(!values?.size)map.delete(key);}}
 blocked(x:number,z:number,feet:number,height=1.75){for(let bx=Math.floor((x-.34)/8);bx<=Math.floor((x+.34)/8);bx++)for(let bz=Math.floor((z-.34)/8);bz<=Math.floor((z+.34)/8);bz++)for(const entry of this.collisionSpatial.get(`${bx},${bz}`)??[])if(entry.visible&&entry.collision?.blocked(x,z,feet,height))return true;return false;}
 supportAt(x:number,z:number,maximum:number){let h=-Infinity;for(const entry of this.collisionSpatial.get(`${Math.floor(x/8)},${Math.floor(z/8)}`)??[])if(entry.visible&&entry.collision)h=Math.max(h,entry.collision.supportAt(x,z,maximum));return h;}
 sampleGroundRoad(x:number,z:number){
  let height=-Infinity;for(const entry of this.groundSpatial.get(`${Math.floor(x/8)},${Math.floor(z/8)}`)??[]){const b=entry.collision?.data.groundBounds;if(entry.visible&&b&&x>=b[0]&&x<=b[2]&&z>=b[1]&&z<=b[3])height=Math.max(height,entry.collision!.groundSupportAt(x,z));}
  if(Number.isFinite(height))return{height,distance:0};
  this.groundCandidates.clear();for(let bx=Math.floor((x-3)/8);bx<=Math.floor((x+3)/8);bx++)for(let bz=Math.floor((z-3)/8);bz<=Math.floor((z+3)/8);bz++)for(const entry of this.groundSpatial.get(`${bx},${bz}`)??[])this.groundCandidates.add(entry);
  let closest:{height:number;distance:number}|null=null;
  for(const entry of this.groundCandidates){const b=entry.collision?.data.groundBounds;if(!entry.visible||!b||x<b[0]-3||x>b[2]+3||z<b[1]-3||z>b[3]+3)continue;const candidate=entry.collision!.sampleGroundRoad(x,z,closest?.distance??3);if(candidate&&(!closest||candidate.distance<closest.distance))closest=candidate;}
  return closest;
 }
 roofAt(x:number,z:number){return this.supportAt(x,z,Infinity);}
 get stats(){let visible=0,textured=0,triangles=0,textures=0;for(const e of this.entries.values()){textures+=e.textures;if(e.visible){visible++;textured+=e.texturedTriangles;triangles+=e.triangles;}}return{settled:this.settled&&this.pending===0,progress:this.tiles.loadProgress,cacheMB:Math.round((this.tiles.lruCache as any).cachedBytes/1048576),loaded:this.entries.size,pending:this.pending,completed:this.completed,cells:this.cells,errors:this.errors,visible,sourceTextures:textures,texturedSurfacePercent:triangles?Math.round(textured/triangles*100):0,cacheHits:0,cacheBudgetMB:this.tiles.lruCache.maxBytesSize/1048576,cacheAtCapacity:this.tiles.lruCache.isFull(),geometry:'original-indexed-survey',errorTarget:this.tiles.errorTarget,preparation:{active:this.preparations.size,budgetMs:2.5,maxSliceMs:Math.round(this.preparationMaxSliceMs*100)/100,yields:this.preparationYields,copiedBytes:this.preparationCopiedBytes,cancelled:this.preparationCancelled}};}
 dispose(){this.disposed=true;this.preparationSession.abort();this.indexer.dispose();this.tiles.dispose();this.tiles.group.removeFromParent();this.entries.clear();this.collisionSpatial.clear();this.groundSpatial.clear();}
}
