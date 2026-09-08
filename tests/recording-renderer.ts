import type {DataArrayTexture,DataTexture,Vector3,WebGLRenderer} from 'three';
/** Records actual upload arguments without allocating a full texture-array mirror. */
export function recordingRenderer(){
 const storage=new WeakMap<DataArrayTexture,Map<string,Uint8Array>>();let uploads=0;
 const renderer={
  capabilities:{getMaxAnisotropy:()=>16},
  copyTextureToTexture(source:DataTexture,destination:DataArrayTexture,_region:unknown,position:Vector3,_sourceLevel=0,destinationLevel=0){
   let levels=storage.get(destination);if(!levels){levels=new Map();storage.set(destination,levels);}
   const data=source.image.data as Uint8Array;
   levels.set(`${position.z}/${destinationLevel}`,Uint8Array.from(data));uploads++;
  },
 }as unknown as WebGLRenderer;
 return {renderer,get uploads(){return uploads;},pixels:(texture:DataArrayTexture,layer:number,level=0)=>{
  const data=storage.get(texture)?.get(`${layer}/${level}`);if(!data)throw Error('Layer has not been uploaded');return data;
 }};
}
