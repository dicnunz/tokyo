import * as THREE from 'three';
import * as WebGLTextureUtils from 'three/addons/utils/WebGLTextureUtils.js';
import {GLTFExporter} from 'three/addons/exporters/GLTFExporter.js';
/** Authoring proxy only. Full-resolution survey images remain in the live site. */
export async function exportCity(groups:THREE.Group[]){
 const output=new THREE.Group();output.name='Tokyo_Shibuya_original_survey_metres';
 for(const group of groups){group.updateWorldMatrix(true,true);group.traverse(object=>{
  const mesh=object as THREE.Mesh;if(!mesh.isMesh||mesh.userData.farTerrainBatch)return;
  if(!mesh.userData.terrainSource){for(let p:THREE.Object3D|null=mesh;p;p=p.parent)if(!p.visible)return;}
  const geometry=mesh.geometry.clone();geometry.applyMatrix4(mesh.matrixWorld);
  const material=(mesh.material as THREE.MeshBasicMaterial).clone();
  // Road custom shaders are runtime-only; their collision geometry remains exact.
  const item=new THREE.Mesh(geometry,material);item.name=mesh.name||'Survey_surface';output.add(item);
 });}
 try{
  const bytes=await new GLTFExporter().setTextureUtils(WebGLTextureUtils).parseAsync(output,{binary:true,maxTextureSize:1024,onlyVisible:true}) as ArrayBuffer;
  const response=await fetch('/api/cinema-export',{method:'POST',headers:{'Content-Type':'model/gltf-binary'},body:bytes});
  if(!response.ok)throw Error(await response.text());return {bytes:bytes.byteLength,meshes:output.children.length};
 }finally{output.traverse((o:any)=>{o.geometry?.dispose();o.material?.dispose();});}
}
