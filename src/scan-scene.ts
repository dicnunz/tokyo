import * as THREE from 'three';

export type ScanTile = {id:string;url:string;surfelUrl?:string;count:number;offset:[number,number,number];scale:number;bounds:[[number,number,number],[number,number,number]]};
export type ScanLocation = {id:string;label:string;position:[number,number,number];floorHeight:number;yaw?:number;pitch?:number;verification?:string};
export type ScanManifest = {title:string;source:string;copyright:string;license:string;licenseUrl:string;surveyDate:string;pointCount:number;sourcePointSpacingMetres:number;origin:{lat:number;lon:number;height:number};locations:ScanLocation[];tiles:ScanTile[]};
export type DecodedScan = {positions:Uint16Array;colors:Uint8Array;counts:Uint8Array;heights:Uint16Array;dimension:number;size:number};

export function decodeScanSurfels(buffer:ArrayBuffer,count:number){
  if(buffer.byteLength!==count*4)throw new Error('Incomplete measured surface directions.');
  return new Int8Array(buffer);
}

/** Lossless RGB deinterleaving. Positions stay at the source file's precision. */
export function decodeScanTile(buffer:ArrayBuffer,scale:number):DecodedScan {
  if(buffer.byteLength%9)throw new Error('Incomplete scan tile.');
  const count=buffer.byteLength/9,size=scale*65535,dimension=Math.round(size/.2)+1;
  if(!Number.isFinite(size)||size<=0||dimension>161)throw new Error('Invalid scan tile scale.');
  const view=new DataView(buffer),positions=new Uint16Array(count*3),colors=new Uint8Array(count*3);
  const cells=dimension**3,counts=new Uint8Array(cells),sums=new Float64Array(cells),heights=new Uint16Array(cells);
  for(let i=0;i<count;i++){
    const offset=i*9,p=i*3,x=view.getUint16(offset,true),y=view.getUint16(offset+2,true),z=view.getUint16(offset+4,true);
    positions[p]=x;positions[p+1]=y;positions[p+2]=z;
    colors[p]=view.getUint8(offset+6);colors[p+1]=view.getUint8(offset+7);colors[p+2]=view.getUint8(offset+8);
    const cx=Math.min(dimension-1,Math.floor(x*scale/.2)),cy=Math.min(dimension-1,Math.floor(y*scale/.2)),cz=Math.min(dimension-1,Math.floor(z*scale/.2));
    const cell=(cz*dimension+cy)*dimension+cx;
    // Saturation only bounds the collision confidence counter. Every measured
    // point and colour still enters the rendering buffers above.
    if(counts[cell]<255){counts[cell]++;sums[cell]+=y;}
  }
  for(let i=0;i<cells;i++)if(counts[i])heights[i]=Math.round(sums[i]/counts[i]);
  return {positions,colors,counts,heights,dimension,size};
}

type TileInfo={source:ScanTile;bounds:THREE.Box3;url:string;surfelUrl?:string};
type Resident={info:TileInfo;points:THREE.Points;decoded:DecodedScan;lastUsed:number};
type DecodeJob={resolve:(value:DecodedScan)=>void;reject:(reason:Error)=>void};
class DecodePool {
  private workers:Worker[]=[];private waiting:Array<{buffer:ArrayBuffer;scale:number;job:DecodeJob}>=[];private active=new Map<Worker,DecodeJob>();private closed=false;
  constructor(){
    const source=`const decode=${decodeScanTile.toString()};self.onmessage=event=>{try{const result=decode(event.data.buffer,event.data.scale);self.postMessage({result},[result.positions.buffer,result.colors.buffer,result.counts.buffer,result.heights.buffer]);}catch(error){self.postMessage({error:String(error.message||error)});}};`;
    const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));
    for(let i=0;i<2;i++){
      const worker=new Worker(url);this.workers.push(worker);
      worker.onmessage=event=>{const job=this.active.get(worker);this.active.delete(worker);if(event.data.error)job?.reject(new Error(event.data.error));else job?.resolve(event.data.result);this.pump();};
      worker.onerror=event=>{this.active.get(worker)?.reject(new Error(event.message));this.active.delete(worker);this.pump();};
    }
    URL.revokeObjectURL(url);
  }
  decode(buffer:ArrayBuffer,scale:number){return new Promise<DecodedScan>((resolve,reject)=>{if(this.closed){reject(new Error('Scan closed.'));return;}this.waiting.push({buffer,scale,job:{resolve,reject}});this.pump();});}
  private pump(){for(const worker of this.workers){if(this.active.has(worker))continue;const next=this.waiting.shift();if(!next)return;this.active.set(worker,next.job);worker.postMessage({buffer:next.buffer,scale:next.scale},[next.buffer]);}}
  dispose(){this.closed=true;for(const worker of this.workers)worker.terminate();for(const job of this.active.values())job.reject(new Error('Scan closed.'));for(const next of this.waiting)next.job.reject(new Error('Scan closed.'));this.active.clear();this.waiting=[];}
}

/** Measured point occupancy supplies support and walls, independently of drawing. */
export class ScanCollision {
  private tiles=new Map<string,{source:ScanTile;decoded:DecodedScan}>();
  private size=8;private cellsPerAxis=40;
  add(source:ScanTile,decoded:DecodedScan){this.size=decoded.size;this.cellsPerAxis=decoded.dimension-1;this.tiles.set(this.key(source.offset[0],source.offset[1],source.offset[2]),{source,decoded});}
  remove(source:ScanTile){this.tiles.delete(this.key(source.offset[0],source.offset[1],source.offset[2]));}
  private key(x:number,y:number,z:number){return `${Math.round(x/this.size)}/${Math.round(y/this.size)}/${Math.round(z/this.size)}`;}
  private cell(gx:number,gy:number,gz:number):number|null {
    const tx=Math.floor(gx/this.cellsPerAxis),ty=Math.floor(gy/this.cellsPerAxis),tz=Math.floor(gz/this.cellsPerAxis),tile=this.tiles.get(`${tx}/${ty}/${tz}`);
    if(!tile)return null;
    const d=tile.decoded,x=gx-tx*this.cellsPerAxis,y=gy-ty*this.cellsPerAxis,z=gz-tz*this.cellsPerAxis,index=(z*d.dimension+y)*d.dimension+x;
    if(d.counts[index]<2)return null;
    return tile.source.offset[1]+d.heights[index]*tile.source.scale;
  }
  groundAt(x:number,z:number,feet:number,maxStep=.42):number|null {
    const upper=feet+maxStep,lower=feet-.9,levels:Array<{height:number;votes:number}>=[];
    // A wall hit in one column cannot become a floor. Support must agree across
    // a two-dimensional patch around the body, including opposite corners.
    for(const dz of [-.22,0,.22])for(const dx of [-.22,0,.22]){
      const gx=Math.floor((x+dx)/.2),gz=Math.floor((z+dz)/.2);
      for(let gy=Math.floor(upper/.2);gy>=Math.floor(lower/.2);gy--){
        const height=this.cell(gx,gy,gz);if(height===null||height>upper||height<lower)continue;
        const match=levels.find(level=>Math.abs(level.height-height)<.13);
        if(match){match.height=(match.height*match.votes+height)/(match.votes+1);match.votes++;}else levels.push({height,votes:1});
        break;
      }
    }
    let chosen:number|null=null;
    for(const level of levels)if(level.votes>=5&&(chosen===null||level.height>chosen))chosen=level.height;
    return chosen;
  }
  blocked(x:number,y:number,z:number,eyeHeight=1.65):boolean {
    const radius=.24,lower=y-eyeHeight+.28,upper=y+.1;
    for(let gz=Math.floor((z-radius)/.2);gz<=Math.floor((z+radius)/.2);gz++)for(let gx=Math.floor((x-radius)/.2);gx<=Math.floor((x+radius)/.2);gx++){
      const dx=Math.max(Math.abs((gx+.5)*.2-x)-.1,0),dz=Math.max(Math.abs((gz+.5)*.2-z)-.1,0);if(dx*dx+dz*dz>radius*radius)continue;
      for(let gy=Math.floor(lower/.2);gy<=Math.floor(upper/.2);gy++){const height=this.cell(gx,gy,gz);if(height!==null&&height>=lower&&height<=upper)return true;}
    }
    return false;
  }
  clear(){this.tiles.clear();}
}

const POINT_BUDGET=2_000_000,RESIDENT_BUDGET=2_400_000,RADIUS=38;
export class ScanScene {
  manifest:ScanManifest|undefined;
  private infos:TileInfo[]=[];private resident=new Map<string,Resident>();private wanted=new Map<string,TileInfo>();
  private pending=new Map<string,AbortController>();private retryAt=new Map<string,number>();private pool:DecodePool|undefined;
  private collision=new ScanCollision();private material:THREE.ShaderMaterial;
  private visibilityMaterial:THREE.ShaderMaterial;private target:THREE.WebGLRenderTarget;private resolveScene=new THREE.Scene();private resolveCamera=new THREE.Camera();private resolveMaterial:THREE.ShaderMaterial;
  private frustum=new THREE.Frustum();private matrix=new THREE.Matrix4();private lastPosition=new THREE.Vector3(Infinity,Infinity,Infinity);private lastRotation=new THREE.Quaternion();
  private lastPlan=-Infinity;private closed=false;private pointCount=0;private sourceError='';private failureCount=0;
  constructor(private group:THREE.Group,private camera:THREE.PerspectiveCamera,private renderer:THREE.WebGLRenderer){
    this.material=new THREE.ShaderMaterial({
      uniforms:{pointScale:{value:1},inverseViewport:{value:new THREE.Vector2(1,1)},rayScale:{value:new THREE.Vector2(1,1)},depthProjection:{value:new THREE.Vector2()},depthOffset:{value:0}},
      vertexShader:`attribute vec3 scanColor;attribute vec4 scanSurfel;varying vec3 vScanColor;varying vec3 vSurfaceCenter;varying vec3 vSurfaceNormal;varying float vRadius;uniform float pointScale;
        void main(){
          vScanColor=scanColor;vec4 view=modelViewMatrix*vec4(position,1.);vSurfaceCenter=view.xyz;
          vSurfaceNormal=normalize(normalMatrix*(scanSurfel.xyz/127.));
          vRadius=max(.01,(scanSurfel.w<0.?scanSurfel.w+256.:scanSurfel.w)*.001);
          gl_Position=projectionMatrix*view;
          gl_PointSize=clamp(2.*vRadius*pointScale/max(.025,-view.z-vRadius),1.,192.);
        }`,
      fragmentShader:`varying vec3 vScanColor;varying vec3 vSurfaceCenter;varying vec3 vSurfaceNormal;varying float vRadius;
        uniform vec2 inverseViewport;uniform vec2 rayScale;uniform vec2 depthProjection;uniform float depthOffset;
        void main(){
          vec3 ray=vec3((gl_FragCoord.xy*inverseViewport*2.-1.)*rayScale,-1.);
          float denominator=dot(vSurfaceNormal,ray);if(abs(denominator)<.00001)discard;
          float distance=dot(vSurfaceNormal,vSurfaceCenter)/denominator;if(distance<.045)discard;
          vec3 difference=ray*distance-vSurfaceCenter;float radius2=dot(difference,difference)/(vRadius*vRadius);
          if(radius2>1.)discard;
          float z=-distance-depthOffset;gl_FragDepth=.5*((depthProjection.x*z+depthProjection.y)/(-z))+.5;
          float weight=exp(-3.*radius2);
          vec3 color=mix(vScanColor/12.92,pow((vScanColor+.055)/1.055,vec3(2.4)),step(vec3(.04045),vScanColor));
          gl_FragColor=vec4(color*weight,weight);
        }`,
      depthTest:true,depthWrite:false,toneMapped:false,blending:THREE.CustomBlending,blendEquation:THREE.AddEquation,blendSrc:THREE.OneFactor,blendDst:THREE.OneFactor,
    });
    // EWA visibility pass: a narrow measured-surface depth envelope allows
    // neighbouring colours to blend while keeping farther walls occluded.
    this.visibilityMaterial=this.material.clone();this.visibilityMaterial.colorWrite=false;this.visibilityMaterial.depthWrite=true;this.visibilityMaterial.blending=THREE.NoBlending;this.visibilityMaterial.uniforms.depthOffset.value=.018;
    this.target=new THREE.WebGLRenderTarget(1,1,{type:THREE.HalfFloatType,format:THREE.RGBAFormat,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:true,stencilBuffer:false});
    this.resolveMaterial=new THREE.ShaderMaterial({uniforms:{accumulation:{value:this.target.texture},background:{value:new THREE.Color('#111819')}},depthTest:false,depthWrite:false,toneMapped:false,
      vertexShader:'varying vec2 vUv;void main(){vUv=position.xy*.5+.5;gl_Position=vec4(position,1.);}',
      fragmentShader:`uniform sampler2D accumulation;uniform vec3 background;varying vec2 vUv;void main(){vec4 value=texture2D(accumulation,vUv);gl_FragColor=vec4(value.a>.0001?value.rgb/value.a:background,1.);
        #include <colorspace_fragment>
      }`});
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([-1,-1,0,3,-1,0,-1,3,0],3));
    const triangle=new THREE.Mesh(geometry,this.resolveMaterial);triangle.frustumCulled=false;this.resolveScene.add(triangle);
  }
  async load(manifestUrl:string){
    const url=new URL(manifestUrl,location.href),response=await fetch(url);if(!response.ok)throw new Error('The measured scan could not be loaded.');
    const manifest=await response.json() as ScanManifest;if(!Array.isArray(manifest.tiles)||!manifest.tiles.length)throw new Error('The scan manifest has no measured tiles.');
    if(this.closed)return;
    this.manifest=manifest;this.infos=manifest.tiles.map(source=>({source,bounds:new THREE.Box3(new THREE.Vector3().fromArray(source.bounds[0]),new THREE.Vector3().fromArray(source.bounds[1])),url:new URL(source.url,url).href,surfelUrl:new URL(source.surfelUrl??`surfels/${source.id}.bin`,url).href}));
    this.pool=new DecodePool();this.lastPlan=-Infinity;
  }
  update(position:THREE.Vector3){
    if(this.closed||!this.manifest)return;
    const now=performance.now();
    const height=this.renderer.domElement.height,width=this.renderer.domElement.width,tangent=Math.tan(this.camera.fov*Math.PI/360);
    for(const material of [this.material,this.visibilityMaterial]){
      material.uniforms.pointScale.value=height/(2*tangent);material.uniforms.inverseViewport.value.set(1/width,1/height);material.uniforms.rayScale.value.set(tangent*this.camera.aspect,tangent);material.uniforms.depthProjection.value.set(this.camera.projectionMatrix.elements[10],this.camera.projectionMatrix.elements[14]);
    }
    if(now-this.lastPlan>120&&(this.lastPosition.distanceToSquared(position)>.36||Math.abs(this.camera.quaternion.dot(this.lastRotation))<.998||now-this.lastPlan>500)){
      this.lastPlan=now;this.lastPosition.copy(position);this.lastRotation.copy(this.camera.quaternion);
      this.camera.updateMatrixWorld();this.matrix.multiplyMatrices(this.camera.projectionMatrix,this.camera.matrixWorldInverse);this.frustum.setFromProjectionMatrix(this.matrix);
      const candidates=this.infos.map(info=>({info,distance:info.bounds.distanceToPoint(position)})).filter(item=>item.distance<RADIUS&&(item.distance<10||this.frustum.intersectsBox(item.info.bounds)));
      candidates.sort((a,b)=>a.distance-b.distance||a.info.source.count-b.info.source.count);
      this.wanted.clear();let selected=0;
      for(const {info}of candidates){if(selected+info.source.count>POINT_BUDGET&&selected)continue;selected+=info.source.count;this.wanted.set(info.source.id,info);}
      for(const [id,tile]of this.resident){tile.points.visible=this.wanted.has(id);if(tile.points.visible)tile.lastUsed=now;}
      for(const [id,controller]of this.pending)if(!this.wanted.has(id))controller.abort();
    }
    this.pump();
  }
  private pump(){
    if(this.closed||!this.pool||this.pending.size>=2)return;
    for(const [id,info]of this.wanted){
      if(this.pending.size>=2)break;
      if(this.resident.has(id)||this.pending.has(id)||(this.retryAt.get(id)??0)>performance.now())continue;
      const controller=new AbortController();this.pending.set(id,controller);
      void this.loadTile(info,controller).catch(error=>{
        if(!controller.signal.aborted&&!this.closed){this.retryAt.set(id,performance.now()+10000);this.failureCount++;this.sourceError=String(error.message||error);}
      }).finally(()=>{this.pending.delete(id);});
    }
  }
  private async loadTile(info:TileInfo,controller:AbortController){
    const [response,surfaceResponse]=await Promise.all([fetch(info.url,{signal:controller.signal}),fetch(info.surfelUrl!,{signal:controller.signal})]);if(!response.ok||!surfaceResponse.ok)throw new Error(`Measured surface ${info.source.id} is unavailable.`);
    const [buffer,surfaceBuffer]=await Promise.all([response.arrayBuffer(),surfaceResponse.arrayBuffer()]);if(buffer.byteLength!==info.source.count*9)throw new Error(`Scan tile ${info.source.id} is incomplete.`);
    const surfels=decodeScanSurfels(surfaceBuffer,info.source.count);
    if(controller.signal.aborted)return;
    const decoded=await this.pool!.decode(buffer,info.source.scale);
    if(this.closed||controller.signal.aborted||!this.wanted.has(info.source.id))return;
    const evictable=[...this.resident.values()].filter(tile=>!this.wanted.has(tile.info.source.id)).sort((a,b)=>a.lastUsed-b.lastUsed);
    for(const tile of evictable){if(this.pointCount+info.source.count<=RESIDENT_BUDGET)break;this.release(tile);}
    const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(decoded.positions,3,true));geometry.setAttribute('scanColor',new THREE.BufferAttribute(decoded.colors,3,true));geometry.setAttribute('scanSurfel',new THREE.BufferAttribute(surfels,4));
    geometry.boundingBox=new THREE.Box3(new THREE.Vector3(0,0,0),new THREE.Vector3(1,1,1));geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(.5,.5,.5),Math.sqrt(3)/2);
    const points=new THREE.Points(geometry,this.material);points.position.fromArray(info.source.offset);points.scale.setScalar(decoded.size);points.name=`Measured scan ${info.source.id}`;points.matrixAutoUpdate=false;points.updateMatrix();
    this.group.add(points);this.resident.set(info.source.id,{info,points,decoded,lastUsed:performance.now()});this.collision.add(info.source,decoded);this.pointCount+=info.source.count;this.retryAt.delete(info.source.id);this.sourceError='';
  }
  groundAt(x:number,z:number,feet:number,maxStep=.42){return this.collision.groundAt(x,z,feet,maxStep);}
  blocked(position:THREE.Vector3,eyeHeight=1.65){return this.collision.blocked(position.x,position.y,position.z,eyeHeight);}
  render(scene:THREE.Scene){
    const renderer=this.renderer,width=renderer.domElement.width,height=renderer.domElement.height;if(this.target.width!==width||this.target.height!==height)this.target.setSize(width,height);
    const background=scene.background,override=scene.overrideMaterial,autoClear=renderer.autoClear,autoReset=renderer.info.autoReset,previousTarget=renderer.getRenderTarget(),clear=new THREE.Color();renderer.getClearColor(clear);const clearAlpha=renderer.getClearAlpha();
    renderer.info.autoReset=false;renderer.info.reset();renderer.autoClear=false;scene.background=null;
    renderer.setRenderTarget(this.target);renderer.setClearColor(0,0);renderer.clear(true,true,true);
    scene.overrideMaterial=this.visibilityMaterial;renderer.render(scene,this.camera);
    scene.overrideMaterial=this.material;renderer.render(scene,this.camera);
    scene.overrideMaterial=override;scene.background=background;
    renderer.setRenderTarget(previousTarget);renderer.render(this.resolveScene,this.resolveCamera);
    renderer.setClearColor(clear,clearAlpha);renderer.autoClear=autoClear;renderer.info.autoReset=autoReset;
  }
  get stats(){let visiblePoints=0;for(const tile of this.resident.values())if(tile.points.visible)visiblePoints+=tile.info.source.count;return {residentPoints:this.pointCount,visiblePoints,residentTiles:this.resident.size,pending:this.pending.size,wantedTiles:this.wanted.size,readyTiles:[...this.wanted.keys()].filter(id=>this.resident.has(id)).length,errors:this.failureCount,error:this.sourceError,totalPoints:this.manifest?.pointCount??0};}
  private release(tile:Resident){this.group.remove(tile.points);tile.points.geometry.dispose();this.collision.remove(tile.info.source);this.resident.delete(tile.info.source.id);this.pointCount-=tile.info.source.count;}
  dispose(){this.closed=true;for(const controller of this.pending.values())controller.abort();this.pool?.dispose();for(const tile of this.resident.values())this.release(tile);this.material.dispose();this.visibilityMaterial.dispose();this.resolveMaterial.dispose();this.target.dispose();for(const child of this.resolveScene.children)(child as THREE.Mesh).geometry.dispose();this.collision.clear();this.wanted.clear();}
}
