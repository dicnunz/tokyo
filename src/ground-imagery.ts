import * as THREE from 'three';
import { GeoFrame } from './geo';
import {createTextureArrayStorage,uploadTextureArrayLayer} from './texture-array-storage';

const GRID = 16, TILE = 256, ZOOM = 18, DETAIL_GRID=8, DETAIL_TILE=512;
const tileAt = (frame: GeoFrame, x: number, y: number, z: number) => {
  const geo = frame.toGeo(x, y, z);
  return new THREE.Vector2((geo.lon + 180) / 360 * 2 ** ZOOM, (1 - Math.asinh(Math.tan(geo.lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** ZOOM);
};
const wrap = (n: number) => ((n % GRID) + GRID) % GRID;

const linear=new Float32Array(256),encoded=new Uint8Array(4097);
for(let i=0;i<256;i++){const s=i/255;linear[i]=s<=.04045?s/12.92:((s+.055)/1.055)**2.4;}
for(let i=0;i<=4096;i++){const v=i/4096;encoded[i]=Math.round(255*(v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055));}
/** Native mip levels average in linear light; level zero is the original image. */
export function groundMipLevels(data:Uint8ClampedArray,size:number){
  const levels:(Uint8Array|Uint8ClampedArray)[]=[data];let previous:Uint8Array|Uint8ClampedArray=data,n=size;
  while(n>1){
    const next=new Uint8Array(n*n),half=n/2;
    for(let row=0;row<half;row++)for(let col=0;col<half;col++){
      const a=((row*2)*n+col*2)*4,b=a+4,c=a+n*4,d=c+4,out=(row*half+col)*4;
      for(let channel=0;channel<3;channel++)next[out+channel]=encoded[Math.round((linear[previous[a+channel]]+linear[previous[b+channel]]+linear[previous[c+channel]]+linear[previous[d+channel]])*1024)];
      next[out+3]=Math.round((previous[a+3]+previous[b+3]+previous[c+3]+previous[d+3])/4);
    }
    levels.push(next);n=half;previous=next;
  }return levels;
}
/** Shared measured imagery, with independent source mip pyramids per tile. */
export class GroundImagery {
  readonly texture: THREE.DataArrayTexture;
  readonly owners: THREE.DataTexture;
  readonly detailTexture: THREE.DataArrayTexture;
  readonly detailOwners: THREE.DataTexture;
  readonly base: THREE.Vector2;
  readonly coefficients: THREE.Vector2[];
  private closed = false;
  private focus = new THREE.Vector2();
  get stats(){
    const count=(texture:THREE.DataTexture)=>{const data=texture.image.data as Float32Array;let n=0;for(let i=0;i<data.length;i+=4)if(data[i]>-1e8)n++;return n;};
    return{baseLayers:count(this.owners),detailedLayers:count(this.detailOwners),textureCpuBytes:0,textureGpuBytes:178956544,filtering:'native-anisotropic',anisotropy:this.texture.anisotropy};
  }
  constructor(frame: GeoFrame,private renderer:THREE.WebGLRenderer) {
    const center = tileAt(frame, 0, 0, 0);
    this.base = center.clone().floor();
    this.focus.copy(this.base);
    const h = 100;
    const sample = (x:number,y:number,z:number) => tileAt(frame,x,y,z).sub(this.base);
    const c = sample(0,0,0);
    const plus = [sample(h,0,0),sample(0,h,0),sample(0,0,h)];
    const minus = [sample(-h,0,0),sample(0,-h,0),sample(0,0,-h)];
    const linear = plus.map((p,i)=>p.clone().sub(minus[i]).multiplyScalar(1/(2*h)));
    const diagonal = plus.map((p,i)=>p.clone().add(minus[i]).addScaledVector(c,-2).multiplyScalar(1/(2*h*h)));
    const cross = [[0,1],[0,2],[1,2]].map(([a,b])=>{
      const v=[0,0,0];v[a]=h;v[b]=h;const pp=sample(v[0],v[1],v[2]);
      v[b]=-h;const pm=sample(v[0],v[1],v[2]);v[a]=-h;const mm=sample(v[0],v[1],v[2]);
      v[b]=h;const mp=sample(v[0],v[1],v[2]);
      return pp.sub(pm).sub(mp).add(mm).multiplyScalar(1/(4*h*h));
    });
    // Work in fractional tiles around the local frame, preserving float precision.
    this.coefficients=[c,...linear,...diagonal,...cross];
    const array=(size:number,grid:number)=>{
      const texture=createTextureArrayStorage(size,size,grid*grid,Math.log2(size)+1);
      texture.colorSpace=THREE.SRGBColorSpace;texture.generateMipmaps=false;
      texture.minFilter=THREE.LinearMipmapLinearFilter;texture.magFilter=THREE.LinearFilter;texture.anisotropy=Math.min(16,renderer.capabilities.getMaxAnisotropy());return texture;
    };
    const ownership=(grid:number)=>{const data=new Float32Array(grid*grid*4);data.fill(-1e9);
      const texture=new THREE.DataTexture(data,grid,grid,THREE.RGBAFormat,THREE.FloatType);
      texture.minFilter=THREE.NearestFilter;texture.magFilter=THREE.NearestFilter;texture.needsUpdate=true;return texture;
    };
    this.texture=array(TILE,GRID);this.owners=ownership(GRID);
    this.detailTexture=array(DETAIL_TILE,DETAIL_GRID);this.detailOwners=ownership(DETAIL_GRID);
  }
  /** CPU mirror of shader mapping, useful for georeferencing verification. */
  tileAtLocal(x:number,y:number,z:number) {
    const factors=[1,x,y,z,x*x,y*y,z*z,x*y,x*z,y*z],result=this.base.clone();
    this.coefficients.forEach((c,i)=>result.addScaledVector(c,factors[i]));return result;
  }
  /** Camera-centred windows contain exactly one owner for every wrapped slot. */
  accepts(x:number,y:number,size=256) {
    const half=(size===DETAIL_TILE?DETAIL_GRID:GRID)/2;
    return x>=this.focus.x-half&&x<this.focus.x+half&&y>=this.focus.y-half&&y<this.focus.y+half;
  }
  setFocus(x:number,y:number) {
    x=Math.floor(x);y=Math.floor(y);
    if(this.closed||(this.focus.x===x&&this.focus.y===y))return false;
    this.focus.set(x,y);
    for(const [texture,size]of [[this.owners,TILE],[this.detailOwners,DETAIL_TILE]] as const){
      const owners=texture.image.data as Float32Array;let changed=false;
      for(let i=0;i<owners.length;i+=4)if(owners[i]>-1e8&&!this.accepts(owners[i]+this.base.x,owners[i+1]+this.base.y,size)){
        owners[i]=owners[i+1]=-1e9;changed=true;
      }
      if(changed)texture.needsUpdate=true;
    }
    return true;
  }
  put(x:number,y:number,pixels:{data:Uint8ClampedArray;width:number;height:number}) {
    if(this.closed || pixels.width!==pixels.height || (pixels.width!==TILE&&pixels.width!==DETAIL_TILE))return;
    if(!this.accepts(x,y,pixels.width))return;
    const detail=pixels.width===DETAIL_TILE,size=pixels.width,grid=detail?DETAIL_GRID:GRID;
    const texture=detail?this.detailTexture:this.texture,ownerTexture=detail?this.detailOwners:this.owners;
    const layer=((y%grid+grid)%grid)*grid+(x%grid+grid)%grid,owners=ownerTexture.image.data as Float32Array;
    if(owners[layer*4]===x-this.base.x&&owners[layer*4+1]===y-this.base.y)return;
    groundMipLevels(pixels.data,size).forEach((data,level)=>uploadTextureArrayLayer(this.renderer,texture,layer,data,level));
    owners[layer*4]=x-this.base.x;owners[layer*4+1]=y-this.base.y;
    ownerTexture.needsUpdate=true;
  }
  apply(material:THREE.Material) {
    if(material.userData.gsiGroundImagery)return;
    material.userData.gsiGroundImagery=true;
    const previous=material.onBeforeCompile;
    const previousKey=material.customProgramCacheKey.bind(material);
    material.onBeforeCompile=(shader,renderer)=>{
      previous.call(material,shader,renderer);
      shader.uniforms.gsiRoadPhotos={value:this.texture};
      shader.uniforms.gsiRoadOwners={value:this.owners};
      shader.uniforms.gsiRoadDetails={value:this.detailTexture};shader.uniforms.gsiDetailOwners={value:this.detailOwners};
      shader.uniforms.gsiDetailPhase={value:new THREE.Vector2((this.base.x%8+8)%8,(this.base.y%8+8)%8)};
      shader.uniforms.gsiRoadPhase={value:new THREE.Vector2(wrap(this.base.x),wrap(this.base.y))};
      shader.uniforms.gsiRoadCoefficients={value:this.coefficients};
      shader.vertexShader=`uniform vec2 gsiRoadCoefficients[10];\nvarying vec2 vGsiRoadTile;\nvarying float vGsiRoadTop;\nvarying vec3 vGsiSurfaceNormal;\n${shader.vertexShader}`;
      shader.vertexShader=shader.vertexShader.replace('#include <project_vertex>',`#include <project_vertex>
        vec3 gsiP=(modelMatrix*vec4(transformed,1.0)).xyz;
        vGsiRoadTile=gsiRoadCoefficients[0]+gsiRoadCoefficients[1]*gsiP.x+gsiRoadCoefficients[2]*gsiP.y+gsiRoadCoefficients[3]*gsiP.z
          +gsiRoadCoefficients[4]*gsiP.x*gsiP.x+gsiRoadCoefficients[5]*gsiP.y*gsiP.y+gsiRoadCoefficients[6]*gsiP.z*gsiP.z
          +gsiRoadCoefficients[7]*gsiP.x*gsiP.y+gsiRoadCoefficients[8]*gsiP.x*gsiP.z+gsiRoadCoefficients[9]*gsiP.y*gsiP.z;
        vGsiSurfaceNormal=normalize(mat3(modelMatrix)*normal);vGsiRoadTop=vGsiSurfaceNormal.y;
      `);
      shader.fragmentShader=`uniform highp sampler2DArray gsiRoadPhotos;\nuniform sampler2D gsiRoadOwners;\nuniform highp sampler2DArray gsiRoadDetails;\nuniform sampler2D gsiDetailOwners;\nuniform vec2 gsiDetailPhase;\nuniform vec2 gsiRoadPhase;\nvarying vec2 vGsiRoadTile;\nvarying float vGsiRoadTop;\nvarying vec3 vGsiSurfaceNormal;\n${shader.fragmentShader}`;
      shader.fragmentShader=`
        vec3 gsiFiltered(highp sampler2DArray photos,vec2 uv,float layer,float size,vec2 dx,vec2 dy){
          return textureGrad(photos,vec3(uv,layer),dx,dy).rgb;
        }
      `+shader.fragmentShader;
      shader.fragmentShader=shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
        vec2 gsiCell=floor(vGsiRoadTile);
        vec2 gsiSlot=mod(gsiCell+gsiRoadPhase,16.0);
        vec2 gsiOwner=texture2D(gsiRoadOwners,(gsiSlot+0.5)/16.0).rg;
        vec2 detailSlot=mod(gsiCell+gsiDetailPhase,8.0),detailOwner=texture2D(gsiDetailOwners,(detailSlot+.5)/8.0).rg;
        // Differentiate the continuous coordinate, never fract(), to avoid LOD
        // spikes and flashing blur at map tile boundaries while moving.
        vec2 dx=dFdx(vGsiRoadTile),dy=dFdy(vGsiRoadTile);
        if(vGsiRoadTop>0.65 && all(lessThan(abs(detailOwner-gsiCell),vec2(.1)))){
          diffuseColor.rgb=gsiFiltered(gsiRoadDetails,fract(vGsiRoadTile),detailSlot.y*8.0+detailSlot.x,512.0,dx,dy);
        }else if(vGsiRoadTop>0.65 && all(lessThan(abs(gsiOwner-gsiCell),vec2(0.1)))) {
          diffuseColor.rgb=gsiFiltered(gsiRoadPhotos,fract(vGsiRoadTile),gsiSlot.y*16.0+gsiSlot.x,256.0,dx,dy);
        }else{
          float faceLight=.62+.38*max(dot(normalize(vGsiSurfaceNormal),normalize(vec3(-.534,.802,.267))),0.0);
          diffuseColor.rgb*=faceLight;
        }
      `);
    };
    material.customProgramCacheKey=()=>`${previousKey()}|gsi-road-imagery-v4-native-mips`;
    material.needsUpdate=true;
  }
  dispose(){if(this.closed)return;this.closed=true;this.texture.dispose();this.owners.dispose();this.detailTexture.dispose();this.detailOwners.dispose();}
}
