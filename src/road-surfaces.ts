/** Continuous survey triangles for roads/bridges. All coordinates are metres. */
export class RoadSurfaces{
 readonly buckets=new Map<string,number[]>();
 constructor(readonly positions:Float32Array,readonly indices:Uint32Array){
  for(let t=0;t<indices.length;t+=3){const ids=[indices[t]*3,indices[t+1]*3,indices[t+2]*3],xs=ids.map(i=>positions[i]),zs=ids.map(i=>positions[i+2]);
   for(let x=Math.floor(Math.min(...xs)/32);x<=Math.floor(Math.max(...xs)/32);x++)for(let z=Math.floor(Math.min(...zs)/32);z<=Math.floor(Math.max(...zs)/32);z++){const key=`${x},${z}`,list=this.buckets.get(key)??[];list.push(t);this.buckets.set(key,list);}
  }
 }
 private nearby(x:number,z:number){return this.buckets.get(`${Math.floor(x/32)},${Math.floor(z/32)}`)??[];}
 private height(t:number,x:number,z:number){const p=this.positions,a=this.indices[t]*3,b=this.indices[t+1]*3,c=this.indices[t+2]*3,den=(p[b+2]-p[c+2])*(p[a]-p[c])+(p[c]-p[b])*(p[a+2]-p[c+2]);if(Math.abs(den)<1e-9)return null;const u=((p[b+2]-p[c+2])*(x-p[c])+(p[c]-p[b])*(z-p[c+2]))/den,v=((p[c+2]-p[a+2])*(x-p[c])+(p[a]-p[c])*(z-p[c+2]))/den;if(u< -1e-6||v< -1e-6||u+v>1.000001)return null;return u*p[a+1]+v*p[b+1]+(1-u-v)*p[c+1];}
 supportAt(x:number,z:number,maximum:number){let h=-Infinity;for(const t of this.nearby(x,z)){const y=this.height(t,x,z);if(y!==null&&y<=maximum)h=Math.max(h,y);}return h;}
 blocked(x:number,z:number,feet:number,height:number){for(const t of this.nearby(x,z)){
  const surface=this.height(t,x,z);if(surface!==null){if(surface>feet+.45&&surface<feet+height)return true;continue;}
  // Vertical source faces, including bridge piers, intersect a body-height slice.
  const p=this.positions,ids=[this.indices[t]*3,this.indices[t+1]*3,this.indices[t+2]*3];
  for(const y of [feet+.5,feet+height*.65]){const cuts:number[][]=[];for(let e=0;e<3;e++){const a=ids[e],b=ids[(e+1)%3],dy=p[b+1]-p[a+1];if(Math.abs(dy)<1e-9)continue;const f=(y-p[a+1])/dy;if(f>=0&&f<=1)cuts.push([p[a]+f*(p[b]-p[a]),p[a+2]+f*(p[b+2]-p[a+2])]);}if(cuts.length>=2){const [a,b]=cuts,dx=b[0]-a[0],dz=b[1]-a[1],len=dx*dx+dz*dz,f=len?Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/len)):0;if(Math.hypot(x-a[0]-f*dx,z-a[1]-f*dz)<.25)return true;}}
 }return false;}
}
