import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {mergeGeometries} from 'three/addons/utils/BufferGeometryUtils.js';
import {GeoFrame} from './geo';
import {Terrain} from './terrain';
import {GroundImagery} from './ground-imagery';
import {roomBlocked,type RoomBox} from './interior-world';

type Placement={id?:string;object:string;lat:number;lon:number;yaw:number;scale?:[number,number,number];heightOffset?:number};
type KitObject={id?:string;node?:string;name?:string;dimensions:[number,number,number];collision?:{type:string;center?:[number,number,number];halfExtents?:[number,number,number];radius?:number;height?:number;insetBase?:number}};
type GroundMaterial={normal?:string;roughness?:string;metresPerRepeat?:number};
type KitManifest={url:string;objects:KitObject[];groundMaterials?:{asphalt?:GroundMaterial;paving?:GroundMaterial}};
type Feature={id:string;properties:Record<string,string>;geometry:{type:string;coordinates:any}};
type Prop={placement:Placement;point:THREE.Vector3;matrix:THREE.Matrix4;mesh:THREE.InstancedMesh;index:number;collision?:RoomBox};
type Road={feature:Feature;points:THREE.Vector3[];width:number;kind:'asphalt'|'paving';mesh?:THREE.Mesh;center:THREE.Vector3};
const BASE='/district/shibuya/';

/** Mapped paths receive close-range surface relief; furniture is authored. */
export class DistrictDetails{
 readonly group=new THREE.Group();
 private closed=false;
 private error='';
 private props:Prop[]=[];
 private roads:Road[]=[];
 private materials:THREE.Material[]=[];
 private roadMaterials:Partial<Record<'asphalt'|'paving',THREE.MeshStandardMaterial>>={};
 private original?:THREE.Group;
 private pending=true;
 private initialized=false;
 private construction?:Generator<void>;
 private lastRefresh=0;
 private focus=new THREE.Vector3();
 private visible=true;
 private triangles=0;
 constructor(private frame:GeoFrame,parent:THREE.Object3D,private renderer:THREE.WebGLRenderer,private terrain:Terrain,private imagery:GroundImagery){this.group.name='Shibuya authored street detail';parent.add(this.group);void this.load();}
 private async load(){
  try{
   const [manifest,placements,corridor]=await Promise.all([fetch(BASE+'manifest.json').then(r=>{if(!r.ok)throw Error('Street kit is being prepared.');return r.json() as Promise<KitManifest>;}),fetch(BASE+'placements.json').then(r=>{if(!r.ok)throw Error('Street placement is being prepared.');return r.json() as Promise<{placements:Placement[]}>;}),fetch(BASE+'corridor.geojson').then(r=>r.json() as Promise<{features:Feature[]}>) ]);
   const source=(await new GLTFLoader().loadAsync(manifest.url)).scene;
   if(this.closed){this.disposeObject(source);return;}this.original=source;source.updateMatrixWorld(true);
   for(const [kind,spec] of Object.entries(manifest.groundMaterials??{})){
    const loader=new THREE.TextureLoader(),load=async(path?:string)=>{if(!path)return null;const texture=await loader.loadAsync(new URL(path,new URL(BASE,location.href)).href);texture.wrapS=texture.wrapT=THREE.RepeatWrapping;texture.anisotropy=this.renderer.capabilities.getMaxAnisotropy();return texture;};
    const [normal,roughness]=await Promise.all([load(spec.normal),load(spec.roughness)]);
    if(this.closed){normal?.dispose();roughness?.dispose();return;}
    const material=new THREE.MeshStandardMaterial({color:0xffffff,roughness:.96,normalMap:normal,roughnessMap:roughness,normalScale:new THREE.Vector2(.55,.55),polygonOffset:true,polygonOffsetFactor:-3,polygonOffsetUnits:kind==='asphalt'?-3:-4});
    this.imagery.apply(material);const prepare=material.onBeforeCompile;
    material.onBeforeCompile=(shader,renderer)=>{prepare.call(material,shader,renderer);shader.fragmentShader=shader.fragmentShader.replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\ndiffuseColor.rgb *= 0.5;');};
    material.userData.metresPerRepeat=spec.metresPerRepeat??2;this.roadMaterials[kind as 'asphalt'|'paving']=material;this.materials.push(material);
   }
   const objects=new Map(manifest.objects.map(object=>[object.id??object.name!,object]));
   const byType=new Map<string,Placement[]>();for(const placement of placements.placements){if(!byType.has(placement.object))byType.set(placement.object,[]);byType.get(placement.object)!.push(placement);}
   for(const [id,items] of byType){
    const spec=objects.get(id),root=source.getObjectByName(spec?.node??spec?.name??id);if(!spec||!root)continue;
    const inverse=root.matrixWorld.clone().invert(),parts=new Map<THREE.Material,THREE.BufferGeometry[]>();
    root.traverse(object=>{
     if(!(object as THREE.Mesh).isMesh)return;const mesh=object as THREE.Mesh,materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
     const transform=new THREE.Matrix4().multiplyMatrices(inverse,mesh.matrixWorld);
     for(let index=0;index<materials.length;index++){
      const material=materials[index];for(const value of Object.values(material))if((value as THREE.Texture)?.isTexture)(value as THREE.Texture).anisotropy=this.renderer.capabilities.getMaxAnisotropy();
      let geometry=mesh.geometry.clone().applyMatrix4(transform);
      if(materials.length>1){const indices:number[]=[],original=geometry.index;for(const group of geometry.groups)if(group.materialIndex===index)for(let i=group.start;i<group.start+group.count;i++)indices.push(original?original.getX(i):i);geometry.setIndex(indices);geometry.clearGroups();}
      if(!parts.has(material))parts.set(material,[]);parts.get(material)!.push(geometry);
     }
    });
    let first=true;
    for(const [material,geometries] of parts){
     const geometry=mergeGeometries(geometries,false);geometries.forEach(item=>item.dispose());if(!geometry)continue;
     const mesh=new THREE.InstancedMesh(geometry,material,items.length);mesh.name=id;mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.frustumCulled=false;
     this.group.add(mesh);this.triangles+=(geometry.index?.count??geometry.getAttribute('position').count)/3*items.length;
     for(let i=0;i<items.length;i++){
      const placement=items[i],point=this.frame.toLocal(placement.lat,placement.lon),matrix=new THREE.Matrix4();matrix.makeScale(0,0,0);mesh.setMatrixAt(i,matrix);
      const prop:Prop={placement,point,matrix,mesh,index:i};
      if(first&&spec.collision&&spec.collision.type!=='surface'&&id!=='curb_segment'){
       const shape=spec.collision,center=shape.center??[0,(shape.height??spec.dimensions[1])/2,0],half=shape.halfExtents??[shape.radius??spec.dimensions[0]/2,(shape.height??spec.dimensions[1])/2,shape.radius??spec.dimensions[2]/2];
       prop.collision={min:center.map((v,i)=>v-half[i]) as [number,number,number],max:center.map((v,i)=>v+half[i]) as [number,number,number]};
      }
      this.props.push(prop);
     }first=false;
    }
   }
   for(const feature of corridor.features){
    const p=feature.properties;if(feature.geometry.type!=='LineString'||!p.highway||['steps','construction','service'].includes(p.highway)||p.level&&p.level!=='0'||p.bridge==='yes'||p.tunnel==='yes')continue;
    const sidewalk=p.highway==='footway'||p.highway==='pedestrian',kind=sidewalk||p.surface==='paving_stones'?'paving':'asphalt';
    if(!this.roadMaterials[kind])continue;
    const points=feature.geometry.coordinates.map(([lon,lat]:number[])=>this.frame.toLocal(lat,lon));
    const center=points.reduce((sum:THREE.Vector3,point:THREE.Vector3)=>sum.add(point),new THREE.Vector3()).multiplyScalar(1/points.length);
    // Widths absent from mapping are authored conservatively along its centre.
    const width=Math.min(12,Math.max(.8,Number(p.width)||(p.footway==='crossing'?4:sidewalk?1.35:p.highway==='residential'?3.5:5)));
    this.roads.push({feature,points,width,kind,center});
   }
   this.pending=false;
  }catch(error){if(!this.closed){this.error=String((error as Error).message);this.pending=false;}}
 }
 private *buildRoad(road:Road){
  const coordinates:number[]=[],uv:number[]=[],indices:number[]=[],material=this.roadMaterials[road.kind]!,metres=material.userData.metresPerRepeat;
  for(let segment=0;segment<road.points.length-1;segment++){
   const a=road.points[segment],b=road.points[segment+1],distance=Math.hypot(b.x-a.x,b.z-a.z),steps=Math.ceil(distance/1.5);if(distance<.1)continue;
   const nx=-(b.z-a.z)/distance*road.width/2,nz=(b.x-a.x)/distance*road.width/2;let previous=-1;
   for(let i=0;i<=steps;i++){
    const x=THREE.MathUtils.lerp(a.x,b.x,i/steps),z=THREE.MathUtils.lerp(a.z,b.z,i/steps),left=this.terrain.heightAt(x+nx,z+nz),right=this.terrain.heightAt(x-nx,z-nz);
    if(left===null||right===null){previous=-1;continue;}
    const index=coordinates.length/3,offset=road.kind==='paving'?.028:.021;
    coordinates.push(x+nx,left+offset,z+nz,x-nx,right+offset,z-nz);uv.push((x+nx)/metres,(z+nz)/metres,(x-nx)/metres,(z-nz)/metres);
    if(previous>=0)indices.push(previous,index,previous+1,previous+1,index,index+1);
    previous=index;if(i%12===0)yield;
   }
  }
  if(!indices.length)return;
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(coordinates,3));geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uv,2));geometry.setIndex(indices);geometry.computeVertexNormals();geometry.computeBoundingSphere();
  const mesh=new THREE.Mesh(geometry,material);mesh.name='Mapped Shibuya '+road.feature.id;mesh.matrixAutoUpdate=false;mesh.updateMatrix();
  if(road.mesh){road.mesh.removeFromParent();road.mesh.geometry.dispose();}this.group.add(mesh);road.mesh=mesh;
 }
 private *construct(){for(const road of this.roads){if(Math.hypot(road.center.x-this.focus.x,road.center.z-this.focus.z)>260)continue;yield* this.buildRoad(road);yield;}this.initialized=true;}
 update(position:THREE.Vector3,settled:boolean){
  if(this.closed||this.pending||this.error)return;
  const anchor=this.frame.toLocal(35.6602,139.6992),visible=Math.hypot(position.x-anchor.x,position.z-anchor.z)<900;this.group.visible=visible;this.visible=visible;if(!visible)return;
  if(performance.now()-this.lastRefresh>500){
   this.lastRefresh=performance.now();
   if(!this.initialized&&settled&&!this.construction){this.focus.copy(position);this.construction=this.construct();}
   if(this.initialized&&settled&&position.distanceTo(this.focus)>65&&!this.construction){this.focus.copy(position);this.construction=this.construct();}
   const object=new THREE.Object3D();
   for(const prop of this.props){
    const height=this.terrain.heightAt(prop.point.x,prop.point.z),near=Math.hypot(prop.point.x-position.x,prop.point.z-position.z)<180;
    if(height===null||!near){prop.matrix.makeScale(0,0,0);}else{object.position.set(prop.point.x,height+.028+(prop.placement.heightOffset??.006),prop.point.z);object.rotation.set(0,prop.placement.yaw??0,0);object.scale.fromArray(prop.placement.scale??[1,1,1]);object.updateMatrix();prop.matrix.copy(object.matrix);}
    prop.mesh.setMatrixAt(prop.index,prop.matrix);prop.mesh.instanceMatrix.needsUpdate=true;
   }
   for(const road of this.roads)if(road.mesh)road.mesh.visible=Math.hypot(road.center.x-position.x,road.center.z-position.z)<240;
  }
  const started=performance.now();while(this.construction&&performance.now()-started<1.25){if(this.construction.next().done)this.construction=undefined;}
 }
 blocked(x:number,z:number,feet:number,height=1.7){
  if(!this.visible)return false;
  const point=new THREE.Vector3(x,feet+height,z),local=new THREE.Vector3();
  for(const prop of this.props){if(!prop.collision||Math.abs(prop.point.x-x)>3||Math.abs(prop.point.z-z)>3||Math.abs(prop.matrix.determinant())<1e-8)continue;local.copy(point).applyMatrix4(prop.matrix.clone().invert());if(roomBlocked(local,[prop.collision],.29,height))return true;}
  return false;
 }
 get stats(){return{ready:!this.pending&&!this.error,props:this.props.length,roadSurfaces:this.roads.filter(road=>road.mesh).length,triangles:this.triangles,building:!!this.construction,error:this.error,source:'Mapped paths with authored surface relief and Blender street furniture'};}
 private disposeObject(root:THREE.Object3D){const geometry=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>(),textures=new Set<THREE.Texture>();root.traverse(object=>{if(!(object as THREE.Mesh).isMesh)return;const mesh=object as THREE.Mesh;geometry.add(mesh.geometry);for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material])materials.add(material);});geometry.forEach(item=>item.dispose());for(const material of materials){for(const value of Object.values(material))if((value as THREE.Texture)?.isTexture)textures.add(value as THREE.Texture);material.dispose();}textures.forEach(item=>item.dispose());}
 dispose(){this.closed=true;this.construction=undefined;this.group.removeFromParent();this.disposeObject(this.group);if(this.original)this.disposeObject(this.original);for(const material of this.materials){for(const value of Object.values(material))if((value as THREE.Texture)?.isTexture)(value as THREE.Texture).dispose();material.dispose();}}
}
