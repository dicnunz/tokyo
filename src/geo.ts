import { Matrix4, Vector3 } from 'three';
const A=6378137, E2=6.6943799901413165e-3, D=Math.PI/180;
export function ecef(lat:number,lon:number,height=0){const p=lat*D,l=lon*D,n=A/Math.sqrt(1-E2*Math.sin(p)**2);return new Vector3((n+height)*Math.cos(p)*Math.cos(l),(n+height)*Math.cos(p)*Math.sin(l),(n*(1-E2)+height)*Math.sin(p));}
export function geodetic(v:Vector3){const lon=Math.atan2(v.y,v.x),r=Math.hypot(v.x,v.y);let lat=Math.atan2(v.z,r*(1-E2)),height=0;for(let i=0;i<8;i++){const n=A/Math.sqrt(1-E2*Math.sin(lat)**2);height=r/Math.cos(lat)-n;lat=Math.atan2(v.z,r*(1-E2*n/(n+height)));}return{lat:lat/D,lon:lon/D,height};}
export class GeoFrame{
 ecefToLocal:Matrix4;localToEcef:Matrix4;elevationOffset=0;
 constructor(public lat:number,public lon:number){const p=lat*D,l=lon*D,o=ecef(lat,lon); const east=new Vector3(-Math.sin(l),Math.cos(l),0),up=new Vector3(Math.cos(p)*Math.cos(l),Math.cos(p)*Math.sin(l),Math.sin(p)),south=new Vector3(Math.sin(p)*Math.cos(l),Math.sin(p)*Math.sin(l),-Math.cos(p));this.localToEcef=new Matrix4().makeBasis(east,up,south).setPosition(o);this.ecefToLocal=this.localToEcef.clone().invert();}
 toLocal(lat:number,lon:number,height=0){return ecef(lat,lon,height+this.elevationOffset).applyMatrix4(this.ecefToLocal);}
 toGeo(x:number,y:number,z:number){const g=geodetic(new Vector3(x,y,z).applyMatrix4(this.localToEcef));g.height-=this.elevationOffset;return g;}
}
