import type {WebGLRenderer} from 'three';
import type {TilesRenderer} from '3d-tiles-renderer/three';
import {KTX2Loader} from 'three/addons/loaders/KTX2Loader.js';
export function createTextureLoader(renderer:WebGLRenderer){return new KTX2Loader().setTranscoderPath('/basis/').setWorkerLimit(2).detectSupport(renderer);}

function retryDelay(response:Response,attempt:number){
 const header=response.headers.get('Retry-After');
 const seconds=header!==null&&header.trim()!==''?Number(header):NaN;
 const date=header!==null?Date.parse(header):NaN;
 const requested=Number.isFinite(seconds)?seconds*1000:Number.isFinite(date)?date-Date.now():250*2**Math.min(attempt,4);
 return Math.min(5000,Math.max(100,requested)*(1+Math.random()*.2));
}
function waitForCapacity(milliseconds:number,signal?:AbortSignal|null){
 signal?.throwIfAborted();
 return new Promise<void>((resolve,reject)=>{
  const done=()=>{signal?.removeEventListener('abort',abort);resolve();};
  const timer=setTimeout(done,milliseconds);
  const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason??new DOMException('Tile request cancelled','AbortError'));};
  signal?.addEventListener('abort',abort,{once:true});
 });
}
/** Queue backpressure keeps the existing coarse tile visible until capacity frees. */
export async function fetchCompressedTile(source:string,options:RequestInit={}){
 const local='/api/tile?url='+encodeURIComponent(source)+'&wait=1';
 for(let attempt=0;;attempt++){
  options.signal?.throwIfAborted();
  let response:Response;
  try{response=await fetch(local,options);}
  catch(error){if(options.signal?.aborted)throw error;return fetch(source,options);}
  if(response.status===429||response.status===503){
   await response.body?.cancel().catch(()=>{});
   await waitForCapacity(retryDelay(response,attempt),options.signal);
   continue;
  }
  if(response.ok)return response;
  await response.body?.cancel().catch(()=>{});
  return fetch(source,options);
 }
}
/** Binary-only rewrite keeps the original URL as the base for relative tiles. */
export function installCompressedTiles(tiles:TilesRenderer,_renderer:WebGLRenderer){
 tiles.registerPlugin({name:'LOCAL_SURVEY_TEXTURE_CACHE',priority:10,fetchData:(url:string,options:RequestInit)=>{
  const source=new URL(url,location.href);
  if(!['assets.cms.plateau.reearth.io','assets.cms.plateauview.mlit.go.jp','api.plateauview.mlit.go.jp'].includes(source.hostname)||!(/\.(b3dm|glb)$/i.test(source.pathname)))return null;
  return fetchCompressedTile(source.href,options);
 }});
}
