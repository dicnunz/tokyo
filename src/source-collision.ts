import {Box3,Triangle,Vector3} from 'three';
export interface CollisionChunk {positions:Float32Array;indices:Uint32Array;matrix:number[];groundTriangles?:Uint32Array}
export interface CollisionData {positions:Float32Array;indices:Uint32Array;buckets:Map<string,Uint32Array>;groundBuckets?:Map<string,Uint32Array>;groundBounds?:number[]}
const CELL=8;
export function indexSourceGeometry(chunks:CollisionChunk[]):CollisionData{
 let vertices=0,count=0;for(const c of chunks){vertices+=c.positions.length;count+=c.indices.length;}
 const positions=new Float32Array(vertices),indices=new Uint32Array(count);let offset=0,at=0;const ground=new Set<number>();
 for(const c of chunks){for(const t of c.groundTriangles??[])ground.add(at+t*3);const p=c.positions,m=c.matrix;for(let i=0;i<p.length;i+=3){const x=p[i],y=p[i+1],z=p[i+2];positions[offset+i]=m[0]*x+m[4]*y+m[8]*z+m[12];positions[offset+i+1]=m[1]*x+m[5]*y+m[9]*z+m[13];positions[offset+i+2]=m[2]*x+m[6]*y+m[10]*z+m[14];}for(const i of c.indices)indices[at++]=i+offset/3;offset+=p.length;}
 const lists=new Map<string,number[]>(),groundLists=new Map<string,number[]>();const groundBounds=[Infinity,Infinity,-Infinity,-Infinity];
 for(let t=0;t<indices.length;t+=3){const a=indices[t]*3,b=indices[t+1]*3,c=indices[t+2]*3,p=positions;
  const minX=Math.floor(Math.min(p[a],p[b],p[c])/CELL),maxX=Math.floor(Math.max(p[a],p[b],p[c])/CELL),minZ=Math.floor(Math.min(p[a+2],p[b+2],p[c+2])/CELL),maxZ=Math.floor(Math.max(p[a+2],p[b+2],p[c+2])/CELL);
  if(ground.has(t)){groundBounds[0]=Math.min(groundBounds[0],p[a],p[b],p[c]);groundBounds[1]=Math.min(groundBounds[1],p[a+2],p[b+2],p[c+2]);groundBounds[2]=Math.max(groundBounds[2],p[a],p[b],p[c]);groundBounds[3]=Math.max(groundBounds[3],p[a+2],p[b+2],p[c+2]);}
  for(let x=minX;x<=maxX;x++)for(let z=minZ;z<=maxZ;z++){const key=`${x},${z}`;let list=lists.get(key);if(!list){list=[];lists.set(key,list);}list.push(t);if(ground.has(t)){let road=groundLists.get(key);if(!road){road=[];groundLists.set(key,road);}road.push(t);}}
 }
 return{positions,indices,buckets:new Map(Array.from(lists,([key,list])=>[key,new Uint32Array(list)])),groundBuckets:new Map(Array.from(groundLists,([key,list])=>[key,new Uint32Array(list)])),groundBounds:ground.size?groundBounds:undefined};
}
export class SourceCollision{
 readonly buckets:Map<string,Uint32Array>;
 private box=new Box3();private triangle=new Triangle();private visited=new Set<number>();
 constructor(readonly data:CollisionData){this.buckets=data.buckets;}
 blocked(x:number,z:number,feet:number,height:number,radius=.34){
  this.box.min.set(x-radius,feet+.45,z-radius);this.box.max.set(x+radius,feet+height,z+radius);this.visited.clear();
  const p=this.data.positions,indices=this.data.indices;
  for(let bx=Math.floor((x-radius)/CELL);bx<=Math.floor((x+radius)/CELL);bx++)for(let bz=Math.floor((z-radius)/CELL);bz<=Math.floor((z+radius)/CELL);bz++)for(const t of this.buckets.get(`${bx},${bz}`)??[]){
   if(this.visited.has(t))continue;this.visited.add(t);const a=indices[t]*3,b=indices[t+1]*3,c=indices[t+2]*3;
   if(Math.max(p[a+1],p[b+1],p[c+1])<feet+.45||Math.min(p[a+1],p[b+1],p[c+1])>feet+height)continue;
   this.triangle.a.fromArray(p,a);this.triangle.b.fromArray(p,b);this.triangle.c.fromArray(p,c);
   if(this.box.intersectsTriangle(this.triangle))return true;
  }return false;
 }
 /** Nearest point on the verified at-grade road footprint, at most 3 m away. */
 sampleGroundRoad(x:number,z:number,maxDistance=3):{height:number;distance:number}|null{
  const inside=this.groundSupportAt(x,z);if(Number.isFinite(inside))return{height:inside,distance:0};
  const buckets=this.data.groundBuckets;if(!buckets)return null;
  const p=this.data.positions,indices=this.data.indices;let best=maxDistance*maxDistance,height=-Infinity;this.visited.clear();
  for(let bx=Math.floor((x-maxDistance)/CELL);bx<=Math.floor((x+maxDistance)/CELL);bx++)for(let bz=Math.floor((z-maxDistance)/CELL);bz<=Math.floor((z+maxDistance)/CELL);bz++)for(const t of buckets.get(`${bx},${bz}`)??[]){
   if(this.visited.has(t))continue;this.visited.add(t);const a=indices[t]*3,b=indices[t+1]*3,c=indices[t+2]*3;
   const area=(p[b]-p[a])*(p[c+2]-p[a+2])-(p[b+2]-p[a+2])*(p[c]-p[a]);if(Math.abs(area)<1e-10)continue;
   const dx=Math.max(0,Math.min(p[a],p[b],p[c])-x,x-Math.max(p[a],p[b],p[c])),dz=Math.max(0,Math.min(p[a+2],p[b+2],p[c+2])-z,z-Math.max(p[a+2],p[b+2],p[c+2]));if(dx*dx+dz*dz>best)continue;
   for(let edge=0;edge<3;edge++){
    const i=edge===0?a:edge===1?b:c,j=edge===0?b:edge===1?c:a,ex=p[j]-p[i],ez=p[j+2]-p[i+2],length=ex*ex+ez*ez;if(length<1e-12)continue;
    const u=Math.max(0,Math.min(1,((x-p[i])*ex+(z-p[i+2])*ez)/length)),qx=p[i]+u*ex-x,qz=p[i+2]+u*ez-z,d=qx*qx+qz*qz;
    if(d<=best){const y=p[i+1]+u*(p[j+1]-p[i+1]);if(d<best||y>height){best=d;height=y;}}
   }
  }return Number.isFinite(height)?{height,distance:Math.sqrt(best)}:null;
 }
 groundSupportAt(x:number,z:number){return this.sampleHeight(x,z,Infinity,this.data.groundBuckets);}
 supportAt(x:number,z:number,maximum:number){return this.sampleHeight(x,z,maximum,this.buckets);}
 private sampleHeight(x:number,z:number,maximum:number,buckets?:Map<string,Uint32Array>){
  let highest=-Infinity;const p=this.data.positions,indices=this.data.indices;
  for(const t of buckets?.get(`${Math.floor(x/CELL)},${Math.floor(z/CELL)}`)??[]){
   const a=indices[t]*3,b=indices[t+1]*3,c=indices[t+2]*3,den=(p[b+2]-p[c+2])*(p[a]-p[c])+(p[c]-p[b])*(p[a+2]-p[c+2]);if(Math.abs(den)<1e-10)continue;
   const u=((p[b+2]-p[c+2])*(x-p[c])+(p[c]-p[b])*(z-p[c+2]))/den,v=((p[c+2]-p[a+2])*(x-p[c])+(p[a]-p[c])*(z-p[c+2]))/den;
   if(u< -1e-6||v< -1e-6||u+v>1.000001)continue;
   const y=u*p[a+1]+v*p[b+1]+(1-u-v)*p[c+1];if(y<=maximum&&y>highest)highest=y;
  }return highest;
 }
}
export class CollisionIndexer{
 private worker:Worker;private id=0;private pending=new Map<number,{resolve:(v:SourceCollision)=>void;reject:(e:Error)=>void}>();
 constructor(){this.worker=new Worker(new URL('./source-collision-worker.ts',import.meta.url),{type:'module'});this.worker.onmessage=({data})=>{const task=this.pending.get(data.id);if(!task)return;this.pending.delete(data.id);if(data.error)task.reject(new Error(data.error));else task.resolve(new SourceCollision(data.result));};this.worker.onerror=e=>{for(const task of this.pending.values())task.reject(new Error(e.message));this.pending.clear();};}
 index(chunks:CollisionChunk[]){const id=this.id++;return new Promise<SourceCollision>((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.worker.postMessage({id,chunks},chunks.flatMap(c=>[c.positions.buffer,c.indices.buffer,...(c.groundTriangles?[c.groundTriangles.buffer]:[])]));});}
 dispose(){this.worker.terminate();for(const task of this.pending.values())task.reject(new Error('Collision indexing disposed'));this.pending.clear();}
}
