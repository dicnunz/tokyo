import * as THREE from 'three';
import { GeoFrame } from './geo';
import type { GroundImagery } from './ground-imagery';
import {FarTerrainBatch} from './far-terrain-batch';

// GSI RGB elevation definition: https://maps.gsi.go.jp/development/demtile.html
const BASE = 'https://cyberjapandata.gsi.go.jp/xyz';
const Z = 18;
const RADIUS = 15;
type Pixels = { data: Uint8ClampedArray; width: number; height: number };
type Chunk = { key: string; x: number; y: number; detail: number; mesh: THREE.Mesh; cellRanges: Uint32Array; photo?: Pixels };
const EDGE_DETAIL = 64;
export type GroundRoadSample={height:number;distance:number};
export type GroundRoadProvider=(x:number,z:number)=>GroundRoadSample|null;
const tileXY = (lat: number, lon: number, zoom: number) => {
  const n = 2 ** zoom, r = lat * Math.PI / 180;
  return { x: (lon + 180) / 360 * n, y: (1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * n };
};
const geoXY = (x: number, y: number, zoom = Z) => ({
  lon: x / 2 ** zoom * 360 - 180,
  lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** zoom))) * 180 / Math.PI,
});
export function decodeGsiElevation(r: number, g: number, b: number): number | null {
  const v = r * 65536 + g * 256 + b;
  return v === 8388608 ? null : (v > 8388608 ? v - 16777216 : v) * .01;
}

export class Terrain {
  private chunks = new Map<string, Chunk>();
  private farBatch:FarTerrainBatch;
  private pending = new Set<string>();
  private pixels = new Map<string, Promise<Pixels | null>>();
  private dem = new Map<string, Pixels>();
  private wanted = new Map<string, {x:number;y:number;detail:number}>();
  private buildQueue = new Set<string>();
  private closed = false;
  private center = '';
  private retryAt = new Map<string, number>();
  private nextRetryAt = Infinity;
  private failedSourceUntil = new Map<string, number>();
  private pinnedDem = new Set<string>();
  private controller = new AbortController();
  private preloadPoints:THREE.Vector3[]=[];
  private detailQueue=new Map<string,{x:number;y:number;mesh:THREE.Mesh;photo:Pixels}>();
  private detailPending=0;
  private imageryRefresh:Chunk[]=[];
  private roadProvider:GroundRoadProvider|undefined;
  private dirtyRoadChunks=new Set<string>();
  // GeoFrame applies the orthometric-to-ellipsoidal correction exactly once.
  constructor(private frame: GeoFrame, private group: THREE.Group, private renderer:THREE.WebGLRenderer, private imagery?: GroundImagery) {this.farBatch=new FarTerrainBatch(group,renderer);}
  get stats() { return { tiles: this.chunks.size, loading: this.pending.size, detailLoading:this.detailPending, missing: this.retryAt.size, source: 'GSI DEM + GSI / PLATEAU Ortho', cellMeters: 2, farBatch:this.farBatch.stats,roadImagery:this.imagery?.stats }; }

  private read(layer: string, zoom: number, x: number, y: number): Promise<Pixels | null> {
    const key = `${layer}/${zoom}/${x}/${y}`;
    const failedUntil = this.failedSourceUntil.get(key);
    if (failedUntil && failedUntil <= Date.now()) {
      this.pixels.delete(key); this.failedSourceUntil.delete(key);
    }
    const existing = this.pixels.get(key);
    if (existing) { this.pixels.delete(key); this.pixels.set(key, existing); return existing; }
    const failed = () => { if (!this.closed) this.failedSourceUntil.set(key, Date.now() + 15000); return null; };
    const promise = (async () => {
      try {
        const url=layer==='tokyo-ortho'?`/api/tokyo-ortho/${zoom}/${x}/${y}.png`:layer==='ortho-all'?`https://tile.plateauview.mlit.go.jp/tiles/${key}.webp`:`${BASE}/${key}.${layer==='seamlessphoto'?'jpg':'png'}`;
        const signal=AbortSignal.any([this.controller.signal,AbortSignal.timeout(layer==='tokyo-ortho'?90000:15000)]);
        let response:Response;
        for(;;){
          response=await fetch(url,{signal});
          if(layer!=='tokyo-ortho'||![429,503].includes(response.status))break;
          await response.body?.cancel();
          await new Promise<void>((resolve,reject)=>{const finish=()=>{signal.removeEventListener('abort',cancel);resolve();},timer=setTimeout(finish,1000+Math.random()*200),cancel=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);reject(signal.reason);};signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();});
        }
        if (!response.ok) return failed();
        const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none' });
        const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d', { willReadFrequently: true })!;
        context.drawImage(bitmap, 0, 0); bitmap.close();
        const result = context.getImageData(0, 0, canvas.width, canvas.height);
        if (!this.closed && !['seamlessphoto','ortho-all','tokyo-ortho'].includes(layer) && (this.pixels.has(key) || this.pinnedDem.has(key))) this.dem.set(key, result);
        return result;
      } catch { return failed(); }
    })();
    this.pixels.set(key, promise);
    // Elevation covering the current walking area cannot be evicted by imagery.
    if (this.pixels.size > 240) for (const oldest of this.pixels.keys()) {
      if (this.pinnedDem.has(oldest)) continue;
      this.pixels.delete(oldest); this.dem.delete(oldest); this.failedSourceUntil.delete(oldest);
      if (this.pixels.size <= 240) break;
    }
    return promise;
  }

  private elevation(lat: number, lon: number): number | null {
    for (const [layer, zoom] of [['dem5a_png',15], ['dem_png',14]] as const) {
      // Interpolate in global pixel coordinates so neighboring DEM tiles share
      // the same samples. Clamping each tile's last pixel created seam steps.
      const t=tileXY(lat,lon,zoom),px=t.x*256,py=t.y*256,ix=Math.floor(px),iy=Math.floor(py),fx=px-ix,fy=py-iy;
      let value=0,weight=0;
      for(let j=0;j<2;j++)for(let i=0;i<2;i++){
        const w=(i?fx:1-fx)*(j?fy:1-fy);if(w<1e-12)continue;
        const gx=ix+i,gy=iy+j,tx=Math.floor(gx/256),ty=Math.floor(gy/256);
        const pixels=this.dem.get(`${layer}/${zoom}/${tx}/${ty}`);if(!pixels)continue;
        const index=((gy-ty*256)*256+gx-tx*256)*4;
        const h=decodeGsiElevation(pixels.data[index],pixels.data[index+1],pixels.data[index+2]);
        if(h!==null){value+=h*w;weight+=w;}
      }
      if(weight>.999999)return value/weight;
    }return null;
  }
  private surfaceAt(chunk:Chunk,x:number,z:number,tx:number,ty:number):number|null {
    const geometry=chunk.mesh.geometry,index=geometry.index!,position=geometry.getAttribute('position');
    const lx=x-chunk.mesh.position.x,lz=z-chunk.mesh.position.z;
    const cx=Math.max(0,Math.min(chunk.detail-1,Math.floor((tx-chunk.x)*chunk.detail)));
    const cy=Math.max(0,Math.min(chunk.detail-1,Math.floor((ty-chunk.y)*chunk.detail)));
    const cell=(i:number,j:number)=>{
      if(i<0||j<0||i>=chunk.detail||j>=chunk.detail)return null;
      const k=(j*chunk.detail+i)*2,start=chunk.cellRanges[k],end=start+chunk.cellRanges[k+1];
      for(let n=start;n<end;n+=3){
        const a=index.getX(n),b=index.getX(n+1),c=index.getX(n+2);
        const ax=position.getX(a),az=position.getZ(a),bx=position.getX(b),bz=position.getZ(b),cx=position.getX(c),cz=position.getZ(c);
        const det=(bz-cz)*(ax-cx)+(cx-bx)*(az-cz);if(Math.abs(det)<1e-12)continue;
        const u=((bz-cz)*(lx-cx)+(cx-bx)*(lz-cz))/det,v=((cz-az)*(lx-cx)+(ax-cx)*(lz-cz))/det;
        if(u>=-1e-7&&v>=-1e-7&&u+v<=1+1e-7)return u*position.getY(a)+v*position.getY(b)+(1-u-v)*position.getY(c)+chunk.mesh.position.y;
      }return null;
    };
    const direct=cell(cx,cy);if(direct!==null)return direct;
    // Geodetic lookup uses a zero-height estimate; neighboring cells handle the
    // tiny horizontal displacement caused by true elevation and Earth curvature.
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(dx||dy){const h=cell(cx+dx,cy+dy);if(h!==null)return h;}
    return null;
  }
  heightAt(x: number, z: number): number | null {
    const geo=this.frame.toGeo(x,0,z),t=tileXY(geo.lat,geo.lon,Z),cx=Math.floor(t.x),cy=Math.floor(t.y);
    const direct=this.chunks.get(`${cx}/${cy}`);
    if(direct){const h=this.surfaceAt(direct,x,z,t.x,t.y);if(h!==null)return h;}
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(dx||dy){
      const chunk=this.chunks.get(`${cx+dx}/${cy+dy}`);if(chunk){const h=this.surfaceAt(chunk,x,z,t.x,t.y);if(h!==null)return h;}
    }return null;
  }
  readyAt(x: number, z: number) { return this.heightAt(x, z) !== null; }

  setRoadSurfaceProvider(provider:GroundRoadProvider){
    this.roadProvider=provider;
    for(const key of this.chunks.keys()){this.dirtyRoadChunks.add(key);this.buildQueue.add(key);}
  }
  invalidateRoadBounds(minX:number,minZ:number,maxX:number,maxZ:number){
    // Only the changed road neighborhood, including its off-road feather, needs
    // a terrain rebuild. Never resample the complete resident city every frame.
    const corners=[[minX-3,minZ-3],[minX-3,maxZ+3],[maxX+3,minZ-3],[maxX+3,maxZ+3]].map(([x,z])=>{const g=this.frame.toGeo(x,0,z);return tileXY(g.lat,g.lon,Z);});
    const west=Math.floor(Math.min(...corners.map(p=>p.x))),east=Math.floor(Math.max(...corners.map(p=>p.x)));
    const north=Math.floor(Math.min(...corners.map(p=>p.y))),south=Math.floor(Math.max(...corners.map(p=>p.y)));
    for(let y=north;y<=south;y++)for(let x=west;x<=east;x++){
      const key=`${x}/${y}`;
      if(this.chunks.has(key)||this.pending.has(key)){this.dirtyRoadChunks.add(key);this.buildQueue.add(key);}
    }
  }
  setPreloadPoints(points:THREE.Vector3[]){this.preloadPoints=points.map(p=>p.clone());this.center='';}
  update(position: THREE.Vector3) {
    if (this.closed) return;
    const geo = this.frame.toGeo(position.x, position.y, position.z), tile = tileXY(geo.lat, geo.lon, Z);
    const cx = Math.floor(tile.x), cy = Math.floor(tile.y), center = `${cx}/${cy}`;
    if (center !== this.center) {
      this.center = center; this.wanted.clear(); this.pinnedDem.clear();this.buildQueue.clear();
      if(this.imagery?.setFocus(cx,cy)){
        this.imageryRefresh=Array.from(this.chunks.values()).filter(c=>this.imagery!.accepts(c.x,c.y)).sort((a,b)=>Math.hypot(a.x-cx,a.y-cy)-Math.hypot(b.x-cx,b.y-cy));
      }
      const unique=new Map<string,{x:number;y:number;detail:number;d:number}>();
      const centers=[{x:cx,y:cy},...this.preloadPoints.map(p=>{const g=this.frame.toGeo(p.x,p.y,p.z),t=tileXY(g.lat,g.lon,Z);return{x:Math.floor(t.x),y:Math.floor(t.y)};})];
      for(const center of centers)for(let dy=-RADIUS;dy<=RADIUS;dy++)for(let dx=-RADIUS;dx<=RADIUS;dx++){
        const d=Math.hypot(dx,dy);if(d>RADIUS+.25)continue;
        const x=center.x+dx,y=center.y+dy,key=`${x}/${y}`,detail=d<2.5?64:d<5.5?16:d<10.5?8:4;
        const old=unique.get(key);if(!old||detail>old.detail)unique.set(key,{x,y,detail,d:Math.hypot(x-cx,y-cy)});
      }
      const candidates=Array.from(unique.values());
      candidates.sort((a,b)=>a.d-b.d);
      for(const item of candidates) {
        const key=`${item.x}/${item.y}`;
        this.wanted.set(key,item);
        if(this.chunks.get(key)?.detail!==item.detail||this.dirtyRoadChunks.has(key)||this.retryAt.has(key))this.buildQueue.add(key);
        for(const [layer,zoom,scale]of [['dem5a_png',15,8],['dem_png',14,16]] as const)
          for(const x of new Set([Math.floor(item.x/scale),Math.floor((item.x+1)/scale)]))
            for(const y of new Set([Math.floor(item.y/scale),Math.floor((item.y+1)/scale)]))this.pinnedDem.add(`${layer}/${zoom}/${x}/${y}`);
      }
      for(const key of this.retryAt.keys()) if(!this.wanted.has(key)) this.retryAt.delete(key);
      for(const [key, chunk] of this.chunks) if(!this.wanted.has(key)) {
        this.farBatch.remove(key);this.group.remove(chunk.mesh); this.release(chunk.mesh); this.chunks.delete(key);this.dirtyRoadChunks.delete(key);
      }
    }
    this.pump();this.pumpDetail();this.refreshImagery();this.farBatch.update();
  }
  private refreshImagery(){
    if(!this.imagery||this.closed||!this.imageryRefresh.length)return;
    const started=performance.now();
    // Only entering window-edge tiles need uploads during movement. Retained
    // owners are no-ops, and source pixels remain on their existing chunks.
    while(this.imageryRefresh.length&&performance.now()-started<2){
      const chunk=this.chunks.get(this.imageryRefresh.shift()!.key);
      if(!chunk)continue;
      if(chunk.photo)this.imagery.put(chunk.x,chunk.y,chunk.photo);
      const image=(chunk.mesh.material as THREE.MeshBasicMaterial).map?.image as Pixels|undefined;
      if(image?.width===512)this.imagery.put(chunk.x,chunk.y,image);
    }
  }
  private retry(key:string,at=Date.now()+16000){
    this.retryAt.set(key,at);this.nextRetryAt=Math.min(this.nextRetryAt,at);
  }
  private pump() {
    if(this.closed) return;
    // Stationary frames do no resident-tile scan. Work enters through a changed
    // camera tile, a road edit, a completed outdated build or a due retry.
    if(Date.now()>=this.nextRetryAt){
      const now=Date.now();this.nextRetryAt=Infinity;
      for(const [key,at]of this.retryAt){
        if(!this.wanted.has(key)){this.retryAt.delete(key);continue;}
        if(at<=now)this.buildQueue.add(key);else this.nextRetryAt=Math.min(this.nextRetryAt,at);
      }
    }
    for(const key of this.buildQueue) {
      if(this.pending.size>=4) break;
      if(this.pending.has(key))continue;
      this.buildQueue.delete(key);
      const item=this.wanted.get(key);if(!item)continue;
      const retry = this.retryAt.get(key);
      if(retry !== undefined && retry > Date.now()&&!this.dirtyRoadChunks.has(key))continue;
      if(this.chunks.get(key)?.detail === item.detail && retry === undefined&&!this.dirtyRoadChunks.has(key)) continue;
      this.retryAt.delete(key);this.pending.add(key);
      void this.build(key,item.x,item.y,item.detail).catch(()=>{if(!this.closed)this.retry(key);}).finally(()=>{
        this.pending.delete(key);
        if(this.closed)return;
        const current=this.wanted.get(key);
        if(current&&(this.dirtyRoadChunks.has(key)||(!this.retryAt.has(key)&&this.chunks.get(key)?.detail!==current.detail)))this.buildQueue.add(key);
      });
    }
  }
  private async build(key:string,x:number,y:number,detail:number) {
    this.dirtyRoadChunks.delete(key);
    const demRequests:Promise<Pixels|null>[]=[];
    for(const [layer,zoom,scale]of [['dem5a_png',15,8],['dem_png',14,16]] as const)
      for(const tx of new Set([Math.floor(x/scale),Math.floor((x+1)/scale)]))
        for(const ty of new Set([Math.floor(y/scale),Math.floor((y+1)/scale)]))demRequests.push(this.read(layer,zoom,tx,ty));
    // LOD and road-height changes reuse the exact resident photograph. The
    // network promise cache is deliberately smaller than the terrain horizon.
    const residentPhoto=this.chunks.get(key)?.photo;
    const [demTiles,photo]=await Promise.all([Promise.all(demRequests),residentPhoto??this.read('seamlessphoto',18,x,y)]);
    if(this.closed || this.wanted.get(key)?.detail!==detail) return;
    if(photo) this.imagery?.put(x,y,photo);
    if(!demTiles.some(Boolean)) { this.retry(key); return; }
    if(photo) this.retryAt.delete(key); else this.retry(key);
    const originGeo = geoXY(x,y), origin = this.frame.toLocal(originGeo.lat,originGeo.lon,0);
    // Source pixels are retained, rather than averaged down to one color per voxel.
    const texture = photo ? new THREE.DataTexture(photo.data, photo.width, photo.height, THREE.RGBAFormat) : null;
    if (texture) {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = Math.min(16,this.renderer.capabilities.getMaxAnisotropy());
      texture.needsUpdate = true;
    }
    const positions:number[]=[],uvs:number[]=[],indices:number[]=[],valid:boolean[]=[];
    const vertices=new Map<string,number>(),step=EDGE_DETAIL/detail,cellRanges=new Uint32Array(detail*detail*2);
    const vertex=(i:number,j:number)=>{
      const key=`${i}/${j}`,old=vertices.get(key);if(old!==undefined)return old;
      const g=geoXY(x+i/EDGE_DETAIL,y+j/EDGE_DETAIL),h=this.elevation(g.lat,g.lon),index=positions.length/3;
      const p=h===null?new THREE.Vector3():this.frame.toLocal(g.lat,g.lon,h).sub(origin);
      if(h!==null&&this.roadProvider){
        const road=this.roadProvider(p.x+origin.x,p.z+origin.z);
        if(road&&Number.isFinite(road.height)&&road.distance>=0&&road.distance<3){
          const t=road.distance/3,weight=1-t*t*(3-2*t);
          p.y+=(road.height-origin.y-p.y)*weight;
        }
      }
      positions.push(p.x,p.y,p.z);uvs.push(i/EDGE_DETAIL,j/EDGE_DETAIL);valid.push(h!==null);vertices.set(key,index);return index;
    };
    const triangle=(a:number,b:number,c:number)=>{if(valid[a]&&valid[b]&&valid[c])indices.push(a,b,c);};
    let sliceStarted=performance.now();
    for(let j=0;j<detail;j++){
      if(performance.now()-sliceStarted>3){
        await new Promise<void>(resolve=>setTimeout(resolve,0));
        if(this.closed || this.wanted.get(key)?.detail!==detail){texture?.dispose();return;}
        sliceStarted=performance.now();
      }
      for(let i=0;i<detail;i++){
        const start=indices.length,left=i*step,right=(i+1)*step,north=j*step,south=(j+1)*step;
        if(step>1&&(i===0||j===0||i===detail-1||j===detail-1)){
          // Every tile edge uses the same fine samples, even on the far LOD.
          // A fan stitches those edge samples to the coarse interior, avoiding
          // cracks without adding any raised/vertical terrain walls or skirts.
          const ring:number[]=[vertex(left,north)];
          if(i===0)for(let k=1;k<step;k++)ring.push(vertex(left,north+k));
          ring.push(vertex(left,south));
          if(j===detail-1)for(let k=1;k<step;k++)ring.push(vertex(left+k,south));
          ring.push(vertex(right,south));
          if(i===detail-1)for(let k=1;k<step;k++)ring.push(vertex(right,south-k));
          ring.push(vertex(right,north));
          if(j===0)for(let k=1;k<step;k++)ring.push(vertex(right-k,north));
          const center=vertex((left+right)/2,(north+south)/2);
          for(let k=0;k<ring.length;k++)triangle(center,ring[k],ring[(k+1)%ring.length]);
        }else{
          const a=vertex(left,north),b=vertex(left,south),c=vertex(right,south),d=vertex(right,north);
          triangle(a,b,c);triangle(a,c,d);
        }
        const cell=(j*detail+i)*2;cellRanges[cell]=start;cellRanges[cell+1]=indices.length-start;
      }
    }
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();geometry.computeBoundingSphere();
    const material=new THREE.MeshBasicMaterial({map:texture,color:photo?0xffffff:0x777b76,toneMapped:true,side:THREE.DoubleSide});
    const mesh=new THREE.Mesh(geometry,material);mesh.position.copy(origin);mesh.name=`GSI terrain ${key}`;mesh.userData.terrainSource=true;
    mesh.matrixAutoUpdate=false;mesh.updateMatrix();
    const old=this.chunks.get(key);
    if(old){
      const previous=old.mesh.material as THREE.MeshBasicMaterial;
      // Local road conformance must not flash back to lower-resolution imagery.
      if(previous.map&&((previous.map.image as any)?.width===512||(previous.map.image as any)?.data===photo?.data||!photo)){
        texture?.dispose();material.map=previous.map;material.color.set(0xffffff);previous.map=null;
      }
      this.group.remove(old.mesh);this.release(old.mesh);
    }
    this.chunks.set(key,{key,x,y,detail,mesh,cellRanges,photo:photo??old?.photo});this.group.add(mesh);
    // Keep the best measured image after leaving the close terrain ring. A
    // geometry LOD change must not switch back to an older, coarser photograph.
    const displayedPhoto=material.map?.image as Pixels|undefined;
    if(detail<=8&&(photo??old?.photo))this.farBatch.upsert(key,x,y,mesh,displayedPhoto?.data?displayedPhoto:(photo??old?.photo)!);else this.farBatch.remove(key);
    if(detail===64&&photo&&(material.map?.image as any)?.width!==512){this.detailQueue.set(key,{x,y,mesh,photo});this.pumpDetail();}
  }
  private pumpDetail(){
    if(this.closed)return;
    for(const [key,item]of this.detailQueue){
      if(this.detailPending>=2)break;this.detailQueue.delete(key);
      if(this.chunks.get(key)?.mesh!==item.mesh)continue;
      this.detailPending++;
      void this.upgradePhoto(key,item).finally(()=>{this.detailPending--;this.pumpDetail();});
    }
  }
  private async upgradePhoto(key:string,item:{x:number;y:number;mesh:THREE.Mesh;photo:Pixels}){
    try{
      const children=await Promise.all([this.readDetailedPhoto(item.x*2,item.y*2),this.readDetailedPhoto(item.x*2+1,item.y*2),this.readDetailedPhoto(item.x*2,item.y*2+1),this.readDetailedPhoto(item.x*2+1,item.y*2+1)]);
      if(this.closed||this.chunks.get(key)?.mesh!==item.mesh||!children.some(Boolean))return;
      const data=new Uint8ClampedArray(512*512*4);let measured=0,slice=performance.now();
      for(let y=0;y<512;y++){
       if(y%32===0&&performance.now()-slice>3){await new Promise<void>(resolve=>setTimeout(resolve,0));if(this.closed||this.chunks.get(key)?.mesh!==item.mesh)return;slice=performance.now();}
       for(let x=0;x<512;x++){
        const child=children[Math.floor(y/256)*2+Math.floor(x/256)],target=(y*512+x)*4;
        const coarse=(Math.floor(y/2)*256+Math.floor(x/2))*4;
        const pixel=((y%256)*256+x%256)*4,alpha=child?child.data[pixel+3]/255:0;
        if(alpha>0)measured++;
        for(let c=0;c<3;c++)data[target+c]=alpha?(child!.data[pixel+c]*alpha+item.photo.data[coarse+c]*(1-alpha)):item.photo.data[coarse+c];
        data[target+3]=255;
       }
      }
      if(!measured)return;
      this.imagery?.put(item.x,item.y,{data,width:512,height:512});
      const texture=new THREE.DataTexture(data,512,512,THREE.RGBAFormat);texture.colorSpace=THREE.SRGBColorSpace;
      texture.generateMipmaps=true;texture.minFilter=THREE.LinearMipmapLinearFilter;texture.magFilter=THREE.LinearFilter;texture.anisotropy=Math.min(16,this.renderer.capabilities.getMaxAnisotropy());texture.needsUpdate=true;
      const material=item.mesh.material as THREE.MeshBasicMaterial,old=material.map;material.map=texture;material.needsUpdate=true;old?.dispose();
    }catch{/* Keep the complete GSI photograph when higher-resolution survey is unavailable. */}
  }
  private async readDetailedPhoto(x:number,y:number):Promise<Pixels|null>{
    const g=geoXY(x+.5,y+.5,19);
    // Native sheet coverage is resolved by the official footprint index. These
    // broad filters avoid asking the source worker about unrelated regions.
    const inTama=g.lon>=138.9&&g.lon<=139.65&&g.lat>=35.45&&g.lat<=35.92;
    const inIzu=g.lon>=138.9&&g.lon<=139.95&&g.lat>=32.4&&g.lat<=34.9;
    const native=(inTama||inIzu)?await this.read('tokyo-ortho',19,x,y):null;
    if(native){let complete=true;for(let i=3;i<native.data.length;i+=4)if(native.data[i]!==255){complete=false;break;}if(complete)return native;}
    const published=await this.read('ortho-all',19,x,y);if(!native)return published;if(!published)return native;
    const data=new Uint8ClampedArray(native.data.length);
    for(let i=0;i<data.length;i+=4){const a=native.data[i+3]/255,b=published.data[i+3]/255*(1-a),alpha=a+b;for(let c=0;c<3;c++)data[i+c]=alpha?(native.data[i+c]*a+published.data[i+c]*b)/alpha:0;data[i+3]=Math.round(alpha*255);}
    return{data,width:native.width,height:native.height};
  }
  private release(mesh: THREE.Mesh) {
    mesh.geometry.dispose();
    const material=mesh.material as THREE.MeshBasicMaterial;
    material.map?.dispose(); material.dispose();
  }
  dispose() {
    this.closed=true;this.controller.abort();this.farBatch.dispose();
    for(const chunk of this.chunks.values()){this.group.remove(chunk.mesh);this.release(chunk.mesh);}
    this.imageryRefresh=[];this.dirtyRoadChunks.clear();this.buildQueue.clear();this.detailQueue.clear();this.chunks.clear();this.pixels.clear();this.dem.clear();this.retryAt.clear();this.failedSourceUntil.clear();this.pinnedDem.clear();
  }
}
