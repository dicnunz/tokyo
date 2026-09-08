import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {createTextureLoader} from './compressed-tiles.ts';

export type Vector=[number,number,number];
export type RoomBox={name?:string;min:Vector;max:Vector};
export type RoomInteraction={id:string;type:'door'|'light'|'coffee';node:string;position:Vector;radius?:number;axis?:'x'|'y'|'z';angle?:number;label?:string};
export type InteriorSpec={id:string;title:string;url:string;spawn:Vector;bounds:RoomBox;collisionBoxes:RoomBox[];exitBox:RoomBox;interactions?:RoomInteraction[];provenance?:unknown;triangles?:number;materials?:number};
export type InteriorManifest={spaces:InteriorSpec[];provenance?:unknown};

/** Swept movement uses the authored physical furniture, including narrow aisles. */
export function roomBlocked(position:THREE.Vector3,boxes:readonly RoomBox[],radius=.27,eyeHeight=1.7){
 const bottom=position.y-eyeHeight+.09,top=position.y+.08;
 return boxes.some(box=>{
  if(top<=box.min[1]||bottom>=box.max[1])return false;
  const x=THREE.MathUtils.clamp(position.x,box.min[0],box.max[0]),z=THREE.MathUtils.clamp(position.z,box.min[2],box.max[2]);
  return (position.x-x)**2+(position.z-z)**2<radius*radius;
 });
}
export function insideBox(position:THREE.Vector3,box:RoomBox,padding=0){return position.x>=box.min[0]-padding&&position.x<=box.max[0]+padding&&position.y>=box.min[1]-padding&&position.y<=box.max[1]+padding&&position.z>=box.min[2]-padding&&position.z<=box.max[2]+padding;}
export function findFloorLanding(position:THREE.Vector3,bounds:RoomBox,blocked:(position:THREE.Vector3)=>boolean){
 const candidate=position.clone();candidate.y=1.7;if(insideBox(candidate,bounds,-.3)&&!blocked(candidate))return candidate;
 for(let radius=.35;radius<=6;radius+=.35)for(let i=0;i<24;i++){const angle=i*Math.PI/12;candidate.set(position.x+Math.cos(angle)*radius,1.7,position.z+Math.sin(angle)*radius);if(insideBox(candidate,bounds,-.3)&&!blocked(candidate))return candidate.clone();}
 return null;
}

function releaseScene(root:THREE.Object3D){
 const geometry=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>();
 root.traverse(object=>{if(!(object as THREE.Mesh).isMesh)return;const mesh=object as THREE.Mesh;geometry.add(mesh.geometry);for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material])materials.add(material);});
 for(const material of materials){for(const value of Object.values(material))if((value as THREE.Texture)?.isTexture)textures.add(value as THREE.Texture);material.dispose();}
 geometry.forEach(item=>item.dispose());textures.forEach(item=>item.dispose());
}

export class InteriorWorld{
 readonly group=new THREE.Group();
 private roots=new Map<string,THREE.Object3D>();
 private originalRotation=new Map<string,THREE.Quaternion>();
 private currentAngles=new Map<string,number>();
 private doorBoxes=new Map<string,THREE.Box3>();
 private targetAngles=new Map<string,number>();
 private activeDoors=new Set<string>();
 private switchesOn=true;
 private coffeeUntil=0;
 private elapsed=0;
 private steam?:THREE.InstancedMesh;
 private coffeeCup?:THREE.Mesh;
 private disposed=false;
 private frame=new THREE.Object3D();
 constructor(readonly spec:InteriorSpec,private renderer:THREE.WebGLRenderer,private lights:THREE.Light[]){this.group.name='furnished-interior';}
 async load(manifestURL:string){
  const source=(await new GLTFLoader().setKTX2Loader(createTextureLoader(this.renderer)).loadAsync(new URL(this.spec.url,manifestURL).href)).scene;
  if(this.disposed){releaseScene(source);return;}
  source.updateMatrixWorld(true);
  // glTF exports Blender watt-based lamps as candela. Calibrate the authored
  // pendants to the exposure used by the interactive room, and retain switches.
  source.traverse(object=>{if((object as THREE.Light).isLight){const light=object as THREE.Light;light.intensity*=.006;light.castShadow=false;this.lights.push(light);}});
  const retained=new Set<THREE.Object3D>();
  for(const interaction of this.spec.interactions??[]){
   const object=source.getObjectByName(interaction.node);if(!object)continue;
   object.traverse(child=>retained.add(child));this.roots.set(interaction.id,object);
  }
  const batches=new Map<string,{material:THREE.Material;geometry:THREE.BufferGeometry[]}>(),originalGeometry=new Set<THREE.BufferGeometry>();
  source.traverse(object=>{
   if(!(object as THREE.Mesh).isMesh)return;const mesh=object as THREE.Mesh;
   for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
    for(const value of Object.values(material))if((value as THREE.Texture)?.isTexture){const texture=value as THREE.Texture;texture.anisotropy=this.renderer.capabilities.getMaxAnisotropy();}
    if((material as THREE.MeshStandardMaterial).isMeshStandardMaterial)(material as THREE.MeshStandardMaterial).envMapIntensity=.6;
   }
   mesh.castShadow=!(mesh.material as THREE.Material).transparent;mesh.receiveShadow=true;
   if(retained.has(object)||Array.isArray(mesh.material))return;
   const attributes=Object.entries(mesh.geometry.attributes).map(([name,value])=>name+':'+value.itemSize).sort().join(',');
   const key=mesh.material.uuid+':'+attributes+':'+!!mesh.geometry.index;
   if(!batches.has(key))batches.set(key,{material:mesh.material,geometry:[]});
   batches.get(key)!.geometry.push(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));originalGeometry.add(mesh.geometry);
  });
  // Preserve exact interaction pivots; static furniture shares material batches.
  for(const [id,object] of this.roots){const world=object.matrixWorld.clone();object.removeFromParent();world.decompose(object.position,object.quaternion,object.scale);this.originalRotation.set(id,object.quaternion.clone());this.currentAngles.set(id,0);this.group.add(object);}
  for(const {material,geometry} of batches.values()){
   const merged=mergeGeometries(geometry,false);if(!merged)throw Error('Interior furniture could not be prepared.');
   const mesh=new THREE.Mesh(merged,material);mesh.castShadow=!material.transparent;mesh.receiveShadow=true;mesh.name=material.name+' furniture';mesh.matrixAutoUpdate=false;mesh.updateMatrix();this.group.add(mesh);geometry.forEach(item=>item.dispose());
  }
  // glTF occasionally contains multi-material pieces; keep those intact.
  const unbatched:THREE.Mesh[]=[];source.traverse(object=>{if((object as THREE.Mesh).isMesh&&Array.isArray((object as THREE.Mesh).material)&&!retained.has(object))unbatched.push(object as THREE.Mesh);});
  for(const mesh of unbatched){const world=mesh.matrixWorld.clone();mesh.removeFromParent();world.decompose(mesh.position,mesh.quaternion,mesh.scale);this.group.add(mesh);}
  originalGeometry.forEach(item=>item.dispose());
  this.group.updateMatrixWorld(true);for(const root of this.roots.values())this.batchInteraction(root);
  this.addCoffeeEffect();this.group.updateMatrixWorld(true);this.refreshDoorBounds();
 }
 private batchInteraction(root:THREE.Object3D){
  const inverse=root.matrixWorld.clone().invert(),parts=new Map<string,{material:THREE.Material;geometry:THREE.BufferGeometry[]}>(),meshes:THREE.Mesh[]=[];
  root.traverse(object=>{if(object===root||!(object as THREE.Mesh).isMesh)return;const mesh=object as THREE.Mesh;if(Array.isArray(mesh.material))return;
   const key=mesh.material.uuid+':'+Object.entries(mesh.geometry.attributes).map(([name,value])=>name+value.itemSize).sort().join(',')+':'+!!mesh.geometry.index;
   if(!parts.has(key))parts.set(key,{material:mesh.material,geometry:[]});
   parts.get(key)!.geometry.push(mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse,mesh.matrixWorld)));meshes.push(mesh);
  });
  for(const mesh of meshes){mesh.removeFromParent();mesh.geometry.dispose();}
  for(const {material,geometry} of parts.values()){const merged=mergeGeometries(geometry,false);geometry.forEach(item=>item.dispose());if(!merged)throw Error('Interactive furniture could not be prepared.');const mesh=new THREE.Mesh(merged,material);mesh.castShadow=!material.transparent;mesh.receiveShadow=true;root.add(mesh);}
 }
 private refreshDoorBounds(){for(const interaction of this.spec.interactions??[]){if(interaction.type!=='door')continue;const object=this.roots.get(interaction.id);if(object)this.doorBoxes.set(interaction.id,new THREE.Box3().setFromObject(object,true));}}
 private addCoffeeEffect(){
  const coffee=this.spec.interactions?.find(item=>item.type==='coffee');if(!coffee)return;
  const material=new THREE.MeshStandardMaterial({color:0xf7f0df,roughness:.35});
  this.coffeeCup=new THREE.Mesh(new THREE.CylinderGeometry(.038,.03,.085,20),material);this.coffeeCup.position.fromArray(coffee.position).add(new THREE.Vector3(0,-.15,.18));this.group.add(this.coffeeCup);
  const coffeeSurface=new THREE.Mesh(new THREE.CylinderGeometry(.033,.033,.002,20),new THREE.MeshStandardMaterial({color:0x352013,roughness:.28}));coffeeSurface.position.y=.04;this.coffeeCup.add(coffeeSurface);
  this.steam=new THREE.InstancedMesh(new THREE.IcosahedronGeometry(.012,1),new THREE.MeshBasicMaterial({color:0xeaf4ee,transparent:true,opacity:.24,depthWrite:false}),8);this.steam.visible=false;this.steam.frustumCulled=false;this.group.add(this.steam);
 }
 nearest(position:THREE.Vector3,direction:THREE.Vector3){
  let best:RoomInteraction|undefined,score=Infinity;
  for(const interaction of this.spec.interactions??[]){const offset=new THREE.Vector3().fromArray(interaction.position).sub(position),distance=offset.length();if(distance>(interaction.radius??2.2)||offset.normalize().dot(direction)<.35)continue;if(distance<score){score=distance;best=interaction;}}
  return best;
 }
 label(interaction:RoomInteraction){return interaction.type==='door'?(this.activeDoors.has(interaction.id)?'Close door':'Open door'):interaction.type==='light'?(this.switchesOn?'Turn lights off':'Turn lights on'):(this.elapsed<this.coffeeUntil?'Brewing coffee…':'Make a coffee');}
 interact(interaction:RoomInteraction){
  if(interaction.type==='door'){
   const isOpen=this.activeDoors.has(interaction.id);isOpen?this.activeDoors.delete(interaction.id):this.activeDoors.add(interaction.id);this.targetAngles.set(interaction.id,isOpen?0:interaction.angle??1.5);
  }else if(interaction.type==='light'){
   this.switchesOn=!this.switchesOn;for(const light of this.lights){light.userData.brightIntensity??=light.intensity;light.intensity=light.userData.brightIntensity*(this.switchesOn?1:.12);}
   this.group.traverse(object=>{if(!(object as THREE.Mesh).isMesh)return;for(const material of Array.isArray((object as THREE.Mesh).material)?(object as THREE.Mesh).material as THREE.Material[]:[(object as THREE.Mesh).material as THREE.Material]){const surface=material as THREE.MeshStandardMaterial;if(surface.emissive?.getHex()){surface.userData.brightEmissive??=surface.emissiveIntensity;surface.emissiveIntensity=surface.userData.brightEmissive*(this.switchesOn?1:.05);}}});
   this.renderer.shadowMap.needsUpdate=true;
  }else if(this.elapsed>=this.coffeeUntil){this.coffeeUntil=this.elapsed+6;}
 }
 update(dt:number){
  this.elapsed+=dt;
  for(const [id,target] of this.targetAngles){const object=this.roots.get(id),interaction=this.spec.interactions?.find(item=>item.id===id);if(!object||!interaction)continue;const axis=interaction.axis??'y',current=this.currentAngles.get(id)??0,angle=Math.abs(current-target)<.001?target:current+(target-current)*(1-Math.exp(-8*dt));
   this.currentAngles.set(id,angle);if(angle===target)this.targetAngles.delete(id);
   const vector=new THREE.Vector3(axis==='x'?1:0,axis==='y'?1:0,axis==='z'?1:0);object.quaternion.copy(this.originalRotation.get(id)!).premultiply(new THREE.Quaternion().setFromAxisAngle(vector,angle));object.updateMatrixWorld(true);this.refreshDoorBounds();this.renderer.shadowMap.needsUpdate=true;
  }
  if(this.steam&&this.coffeeCup){this.steam.visible=this.elapsed<this.coffeeUntil;for(let i=0;i<8&&this.steam.visible;i++){const phase=(this.elapsed*.42+i/8)%1;this.frame.position.copy(this.coffeeCup.position).add(new THREE.Vector3(Math.sin(this.elapsed*2+i)*.017,.05+phase*.28,Math.cos(this.elapsed*1.3+i)*.014));this.frame.scale.setScalar(.5+phase*1.1);this.frame.updateMatrix();this.steam.setMatrixAt(i,this.frame.matrix);}if(this.steam.visible)this.steam.instanceMatrix.needsUpdate=true;}
 }
 blocked(position:THREE.Vector3){
  const boxes=this.spec.collisionBoxes.filter(box=>!this.spec.interactions?.some(item=>item.type==='door'&&this.activeDoors.has(item.id)&&(box.name===item.node||box.name===item.id)));
  if(roomBlocked(position,boxes))return true;
  for(const box of this.doorBoxes.values())if(!box.isEmpty()&&roomBlocked(position,[{min:box.min.toArray(),max:box.max.toArray()}]))return true;
  return false;
 }
 dispose(){if(this.disposed)return;this.disposed=true;this.group.removeFromParent();releaseScene(this.group);}
}
