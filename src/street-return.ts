export type StreetPose={lat:number;lon:number;height:number;yaw:number;pitch:number;name:string};
const key='tokyo-street-return-v1';
export function saveStreetReturn(pose:StreetPose){sessionStorage.setItem(key,JSON.stringify(pose));}
export function readStreetReturn(){
 try{const pose=JSON.parse(sessionStorage.getItem(key)??'null') as StreetPose|null;
  if(!pose||![pose.lat,pose.lon,pose.height,pose.yaw,pose.pitch].every(Number.isFinite)||pose.lat<20||pose.lat>46||pose.lon<122||pose.lon>154)return null;
  return pose;
 }catch{return null;}
}
export function streetReturnURL(){const pose=readStreetReturn();return pose?`/?lat=${pose.lat.toFixed(8)}&lon=${pose.lon.toFixed(8)}&return=street`:'/?lat=35.6595&lon=139.7005';}
