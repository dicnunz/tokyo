import * as THREE from 'three';
import {groundMipLevels} from './ground-imagery';
import {createTextureArrayStorage,uploadTextureArrayLayer} from './texture-array-storage';
type Photo={data:Uint8ClampedArray;width:number;height:number};
type Member={key:string;x:number;y:number;mesh:THREE.Mesh;photo:Photo;layer:number};
type Page={key:string;size:number;capacity:number;origin:THREE.Vector3;members:Map<string,Member>;mesh:THREE.Mesh;texture:THREE.DataArrayTexture;active:Float32Array;free:number[];uploaded:Map<number,Uint8ClampedArray>;dirty:boolean;disposed:boolean};
const SIZE=256;
/** Far visuals only: original terrain meshes remain authoritative for walking/export. */
export class FarTerrainBatch{
 private pages=new Map<string,Page>();private membership=new Map<string,Page>();private pending:Promise<void>|null=null;private closed=false;private nextPage=0;
 constructor(private group:THREE.Group,private renderer:THREE.WebGLRenderer){}
 get stats(){let capacity=0,textureGpuBytes=0,detailedTiles=0;for(const p of this.pages.values()){capacity+=p.capacity;for(let n=p.size;n>=1;n/=2)textureGpuBytes+=n*n*4*p.capacity;if(p.size===512)detailedTiles+=p.members.size;}return{pages:this.pages.size,tiles:this.membership.size,detailedTiles,building:!!this.pending,capacity,textureCpuBytes:0,textureGpuBytes};}
 upsert(key:string,x:number,y:number,mesh:THREE.Mesh,photo:Photo){
  if(this.closed||![256,512].includes(photo.width)||photo.height!==photo.width)return;
  let page=this.membership.get(key);
  if(page&&page.size!==photo.width){this.remove(key);page=undefined;}
  // Geographic pages left most of their reserved GPU layers empty. Assign a
  // free physical layer in the nearest batch, independent of map tile indices.
  // The original positions and UVs remain unchanged, including island frames.
  if(!page){let nearest=Infinity;for(const candidate of this.pages.values())if(candidate.size===photo.width&&candidate.free.length){const distance=candidate.origin.distanceToSquared(mesh.position);if(distance<nearest){page=candidate;nearest=distance;}}}
  if(!page){
   const size=photo.width,capacity=64*(SIZE/size)**2,pageKey=String(this.nextPage++),texture=createTextureArrayStorage(size,size,capacity,Math.log2(size)+1);
   texture.colorSpace=THREE.SRGBColorSpace;texture.generateMipmaps=false;texture.minFilter=THREE.LinearMipmapLinearFilter;texture.magFilter=THREE.LinearFilter;texture.anisotropy=Math.min(16,this.renderer.capabilities.getMaxAnisotropy());
   const active=new Float32Array(64),material=new THREE.MeshBasicMaterial({side:THREE.DoubleSide,toneMapped:true});
   material.onBeforeCompile=shader=>{
    shader.uniforms.farPhotos={value:texture};shader.uniforms.farActive={value:active};
    shader.vertexShader=`attribute float terrainLayer; varying float vTerrainLayer; varying vec2 vTerrainUv;\n${shader.vertexShader}`.replace('#include <uv_vertex>','#include <uv_vertex>\nvTerrainLayer=terrainLayer;vTerrainUv=uv;');
    shader.fragmentShader=`uniform highp sampler2DArray farPhotos;uniform float farActive[64];varying float vTerrainLayer;varying vec2 vTerrainUv;
     vec3 farColor(vec2 uv,float layer){return textureGrad(farPhotos,vec3(uv,layer),dFdx(uv),dFdy(uv)).rgb;}
     ${shader.fragmentShader}`.replace('#include <map_fragment>','#include <map_fragment>\nif(farActive[int(vTerrainLayer+.5)]<.5)discard;diffuseColor.rgb=farColor(vTerrainUv,floor(vTerrainLayer+.5));');
   };
   material.customProgramCacheKey=()=> 'measured-far-terrain-page-v3-native-mips';
   const batchMesh=new THREE.Mesh(new THREE.BufferGeometry(),material);batchMesh.name=`GSI far terrain page ${pageKey}`;batchMesh.userData.farTerrainBatch=true;batchMesh.matrixAutoUpdate=false;batchMesh.position.copy(mesh.position);batchMesh.updateMatrix();
   page={key:pageKey,size,capacity,origin:mesh.position.clone(),members:new Map(),mesh:batchMesh,texture,active,free:Array.from({length:capacity},(_,i)=>capacity-1-i),uploaded:new Map(),dirty:true,disposed:false};this.pages.set(pageKey,page);
  }
  const previous=page.members.get(key),layer=previous?.layer??page.free.pop()!;
  if(previous?.mesh===mesh&&previous.photo.data===photo.data)return;
  page.active[layer]=0;page.members.set(key,{key,x,y,mesh,photo,layer});page.dirty=true;this.membership.set(key,page);mesh.visible=true;
 }
 remove(key:string){
  const page=this.membership.get(key);if(!page)return;
  const member=page.members.get(key);if(member){page.active[member.layer]=0;member.mesh.visible=true;page.members.delete(key);page.uploaded.delete(member.layer);page.free.push(member.layer);}
  this.membership.delete(key);page.dirty=true;
  if(!page.members.size)this.release(page);
 }
 update(){
  if(this.closed||this.pending)return;
  const page=Array.from(this.pages.values()).find(p=>p.dirty);if(!page)return;
  page.dirty=false;this.pending=this.build(page).finally(()=>{this.pending=null;});
 }
 /** Deterministic checkpoint for export/capture tests; normal frames use update(). */
 async flush(){while(!this.closed&&(this.pending||Array.from(this.pages.values()).some(p=>p.dirty))){this.update();if(this.pending)await this.pending;}}
 private async build(page:Page){
  const members=Array.from(page.members.values());let vertexCount=0,indexCount=0;
  for(const m of members){vertexCount+=m.mesh.geometry.getAttribute('position').count;indexCount+=m.mesh.geometry.index!.count;}
  const positions=new Float32Array(vertexCount*3),uvs=new Float32Array(vertexCount*2),layers=new Float32Array(vertexCount),indices=new Uint32Array(indexCount);
  let vertexOffset=0,indexOffset=0,slice=performance.now();
  for(const m of members){
   if(this.closed||page.disposed)return;
   if(performance.now()-slice>2){await new Promise<void>(resolve=>setTimeout(resolve,0));slice=performance.now();if(this.closed||page.disposed)return;}
   if(page.uploaded.get(m.layer)!==m.photo.data){groundMipLevels(m.photo.data,page.size).forEach((pixels,level)=>uploadTextureArrayLayer(this.renderer,page.texture,m.layer,pixels,level));page.uploaded.set(m.layer,m.photo.data);}
   const geometry=m.mesh.geometry,p=geometry.getAttribute('position'),uv=geometry.getAttribute('uv'),index=geometry.index!,offset=m.mesh.position.clone().sub(page.origin);
   for(let i=0;i<p.count;i++){const v=vertexOffset+i;positions[v*3]=p.getX(i)+offset.x;positions[v*3+1]=p.getY(i)+offset.y;positions[v*3+2]=p.getZ(i)+offset.z;uvs[v*2]=uv.getX(i);uvs[v*2+1]=uv.getY(i);layers[v]=m.layer;}
   for(let i=0;i<index.count;i++)indices[indexOffset++]=index.getX(i)+vertexOffset;
   vertexOffset+=p.count;
  }
  if(this.closed||page.disposed)return;
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));geometry.setAttribute('uv',new THREE.BufferAttribute(uvs,2));geometry.setAttribute('terrainLayer',new THREE.BufferAttribute(layers,1));geometry.setIndex(new THREE.BufferAttribute(indices,1));geometry.computeBoundingSphere();
  page.mesh.geometry.dispose();page.mesh.geometry=geometry;if(!page.mesh.parent)this.group.add(page.mesh);
  page.active.fill(0);
  for(const m of members)if(page.members.get(m.key)===m){page.active[m.layer]=1;if(m.mesh.visible){m.mesh.visible=false;m.mesh.geometry.dispose();(m.mesh.material as THREE.MeshBasicMaterial).map?.dispose();}}
 }
 private release(page:Page){page.disposed=true;page.mesh.removeFromParent();page.mesh.geometry.dispose();(page.mesh.material as THREE.Material).dispose();page.texture.dispose();this.pages.delete(page.key);}
 dispose(){this.closed=true;for(const page of this.pages.values()){for(const m of page.members.values())m.mesh.visible=true;this.release(page);}this.membership.clear();}
}
