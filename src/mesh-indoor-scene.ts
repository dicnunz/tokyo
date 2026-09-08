import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {createTextureLoader} from './compressed-tiles';
import {CollisionIndexer,type SourceCollision} from './source-collision';

export type IndoorLocation={id:string;label:string;position:[number,number,number];floorHeight:number;yaw?:number;pitch?:number;floorId?:string};
type Floor={id:string;label:string;elevation:number;url:string;rooms:number;triangles:number;locations:IndoorLocation[]};
type IndoorManifest={title?:string;origin:{lat:number;lon:number};floors:Floor[];locations:IndoorLocation[];attribution?:string;license?:string;sourceURL?:string;source?:string;dataYear?:string;sourceCaptureDate?:string};

/** Original measured room surfaces, with one floor resident at a time. */
export class MeshIndoorScene{
 manifest:IndoorManifest|null=null;
 private loader=new GLTFLoader();private indexer=new CollisionIndexer();private collision?:SourceCollision;
 private resident:THREE.Group|null=null;private pending=0;private error='';private closed=false;private generation=0;private currentFloor?:Floor;
 private manifestURL='';private locations=new Map<string,Floor>();
 constructor(private group:THREE.Group,_camera:THREE.PerspectiveCamera,renderer:THREE.WebGLRenderer){this.loader.setKTX2Loader(createTextureLoader(renderer));}
 async load(url:string){
  this.manifestURL=new URL(url,location.href).href;const response=await fetch(this.manifestURL);if(!response.ok)throw Error('Indoor survey is still being prepared.');
  const manifest:IndoorManifest=await response.json();manifest.locations=[];
  for(const floor of manifest.floors)for(let i=0;i<(floor.locations??[]).length;i++){
   const item=floor.locations[i];const place:IndoorLocation={...item,id:`${floor.id}:${i}`,label:floor.label+(floor.locations.length>1?` · ${i+1}`:''),floorId:floor.id};
   this.locations.set(place.id,floor);manifest.locations.push(place);
  }
  this.manifest=manifest;
  if(manifest.floors.length)await this.loadFloor(manifest.floors[0]);return manifest;
 }
 async selectLocation(id:string){const floor=this.locations.get(id);if(floor&&floor!==this.currentFloor)await this.loadFloor(floor);}
 private async loadFloor(floor:Floor){
  const generation=++this.generation;this.pending++;this.error='';
  try{
   const gltf=await this.loader.loadAsync(new URL(floor.url,this.manifestURL).href);
   if(this.closed||generation!==this.generation){this.release(gltf.scene);return;}
   const scene=this.batch(gltf.scene);scene.updateMatrixWorld(true);
   const chunks:any[]=[];
   scene.traverse(o=>{if(!(o as THREE.Mesh).isMesh)return;const m=o as THREE.Mesh,p=m.geometry.getAttribute('position');chunks.push({positions:new Float32Array(p.array as Float32Array),indices:m.geometry.index?new Uint32Array(m.geometry.index.array):Uint32Array.from({length:p.count},(_,i)=>i),matrix:m.matrixWorld.toArray()});});
   const collision=await this.indexer.index(chunks);
   if(this.closed||generation!==this.generation){this.release(scene);return;}
   const old=this.resident;this.group.add(scene);this.resident=scene;this.collision=collision;this.currentFloor=floor;if(old){old.removeFromParent();this.release(old);}
  }catch(e){this.error=String((e as Error).message??e);throw e;}finally{this.pending--;}
 }
 private batch(source:THREE.Group){
  source.updateMatrixWorld(true);const batches=new Map<THREE.Material,{material:THREE.MeshStandardMaterial;geometries:THREE.BufferGeometry[]}>();
  source.traverse(object=>{if(!(object as THREE.Mesh).isMesh)return;const mesh=object as THREE.Mesh;
   if(String(mesh.userData.sourceFeatureType??'').split(':').at(-1)==='ClosureSurface')return;
   // Converted floor assets have one material per mesh. Preserve source UVs and colors.
   if(Array.isArray(mesh.material))throw Error('Unexpected multi-material indoor mesh');
   const original=mesh.material as THREE.MeshStandardMaterial;let batch=batches.get(original);
   if(!batch){const material=new THREE.MeshStandardMaterial({color:original.color,map:original.map,vertexColors:original.vertexColors,side:THREE.DoubleSide,roughness:original.roughness??.8,metalness:original.metalness??0,transparent:original.transparent,opacity:original.opacity,alphaTest:original.alphaTest});batch={material,geometries:[]};batches.set(original,batch);}
   const geometry=mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);if(!geometry.getAttribute('normal'))geometry.computeVertexNormals();batch.geometries.push(geometry);
  });
  const result=new THREE.Group();result.name='Measured indoor room surfaces';result.matrixAutoUpdate=false;
  for(const {material,geometries}of batches.values()){
   const merged=mergeGeometries(geometries,false);if(merged){for(const g of geometries)g.dispose();merged.computeBoundingBox();merged.computeBoundingSphere();const mesh=new THREE.Mesh(merged,material);mesh.matrixAutoUpdate=false;result.add(mesh);}else for(const geometry of geometries){const mesh=new THREE.Mesh(geometry,material);mesh.matrixAutoUpdate=false;result.add(mesh);}
  }
  source.traverse(o=>{if((o as THREE.Mesh).isMesh){const m=o as THREE.Mesh;m.geometry.dispose();for(const material of Array.isArray(m.material)?m.material:[m.material])material.dispose();}});
  return result;
 }
 update(_position:THREE.Vector3){}
 groundAt(x:number,z:number,feet:number,maxStep=.35){const height=this.collision?.supportAt(x,z,feet+maxStep)??-Infinity;return Number.isFinite(height)?height:null;}
 blocked(position:THREE.Vector3,eyeHeight=1.7){return this.collision?.blocked(position.x,position.z,position.y-eyeHeight+.2,eyeHeight-.25)??true;}
 get stats(){return{residentPoints:0,visiblePoints:0,totalPoints:0,residentTiles:this.resident?1:0,pending:this.pending,wantedTiles:1,readyTiles:this.resident?1:0,errors:this.error?1:0,error:this.error,triangles:this.currentFloor?.triangles??0,rooms:this.currentFloor?.rooms??0,floors:this.manifest?.floors.length??0,floor:this.currentFloor?.label,representation:'surveyed room geometry'};}
 private release(scene:THREE.Object3D){const textures=new Set<THREE.Texture>();const materials=new Set<THREE.Material>();scene.traverse(o=>{if((o as THREE.Mesh).isMesh){const m=o as THREE.Mesh;m.geometry.dispose();for(const material of Array.isArray(m.material)?m.material:[m.material])materials.add(material);}});for(const material of materials){for(const v of Object.values(material))if((v as THREE.Texture)?.isTexture)textures.add(v as THREE.Texture);material.dispose();}for(const t of textures)t.dispose();}
 dispose(){this.closed=true;this.generation++;this.indexer.dispose();this.collision=undefined;if(this.resident){this.resident.removeFromParent();this.release(this.resident);this.resident=null;}}
}
