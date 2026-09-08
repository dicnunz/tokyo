import type {BufferAttribute,InterleavedBufferAttribute} from 'three';

const COPY_BYTES=64*1024,VERTICES_PER_STEP=1024;
type CopyArray=Float32Array|Uint32Array|Uint16Array|Uint8Array;
type SchedulingOptions={budgetMs?:number;now?:()=>number;yieldTask?:()=>Promise<void>;onSlice?:(milliseconds:number)=>void};

function yieldToBrowser(){
 const scheduler=(globalThis as typeof globalThis&{scheduler?:{yield?:()=>Promise<void>}}).scheduler;
 return scheduler?.yield?scheduler.yield():new Promise<void>(resolve=>setTimeout(resolve,0));
}
function abortable<T>(operation:Promise<T>,signal:AbortSignal){
 return new Promise<T>((resolve,reject)=>{
  let settled=false;
  const settle=(callback:(value:any)=>void,value:unknown)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);callback(value);};
  const abort=()=>settle(reject,signal.reason??new DOMException('Tile preparation cancelled','AbortError'));
  operation.then(value=>settle(resolve,value),error=>settle(reject,error));
  if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
 });
}

/** Cooperative wall-time slices; worker waits and browser scheduling are excluded. */
export class PreparationBudget{
 readonly signal:AbortSignal;
 yields=0;copiedBytes=0;maxSliceMs=0;
 private readonly budgetMs:number;private readonly now:()=>number;private readonly yieldTask:()=>Promise<void>;private readonly onSlice?:SchedulingOptions['onSlice'];
 private started:number;private running=true;
 constructor(signal:AbortSignal,options:SchedulingOptions={}){
  this.signal=signal;this.budgetMs=options.budgetMs??2.5;this.now=options.now??(()=>performance.now());this.yieldTask=options.yieldTask??yieldToBrowser;this.onSlice=options.onSlice;this.started=this.now();
  if(!Number.isFinite(this.budgetMs)||this.budgetMs<=0)throw new RangeError('Preparation budget must be positive');
 }
 check(){this.signal.throwIfAborted();}
 private recordSlice(){
  if(!this.running)return;this.running=false;const elapsed=Math.max(0,this.now()-this.started);
  this.maxSliceMs=Math.max(this.maxSliceMs,elapsed);this.onSlice?.(elapsed);
 }
 /** A null return avoids an unnecessary microtask for small preparation steps. */
 checkpoint():Promise<void>|null{
  this.check();if(this.now()-this.started<this.budgetMs)return null;
  this.yields++;return this.wait(this.yieldTask);
 }
 async wait<T>(start:()=>Promise<T>):Promise<T>{
  this.check();this.recordSlice();
  try{const value=await abortable(start(),this.signal);this.check();return value;}
  finally{this.started=this.now();this.running=true;}
 }
 finish(){this.recordSlice();}
}

/** Exact byte copies retain typed subviews, signed zero, and NaN payload bits. */
export async function copyTypedArray<T extends CopyArray>(source:T,budget:PreparationBudget):Promise<T>{
 budget.check();const Constructor=source.constructor as {new(length:number):T},target=new Constructor(source.length);
 const input=new Uint8Array(source.buffer,source.byteOffset,source.byteLength),output=new Uint8Array(target.buffer,target.byteOffset,target.byteLength);
 for(let offset=0;offset<input.length;offset+=COPY_BYTES){
  const end=Math.min(input.length,offset+COPY_BYTES);output.set(input.subarray(offset,end),offset);budget.copiedBytes+=end-offset;
  const pause=budget.checkpoint();if(pause)await pause;
 }
 budget.check();return target;
}

/** Only the collision copy is packed; the render attribute is never modified. */
export async function copyPositionAttribute(attribute:BufferAttribute|InterleavedBufferAttribute,budget:PreparationBudget){
 if(!('isInterleavedBufferAttribute'in attribute)&&attribute.array instanceof Float32Array&&attribute.itemSize===3&&!attribute.normalized)return copyTypedArray(attribute.array,budget);
 budget.check();const target=new Float32Array(attribute.count*3);
 for(let start=0;start<attribute.count;start+=VERTICES_PER_STEP){
  const end=Math.min(attribute.count,start+VERTICES_PER_STEP);
  for(let i=start;i<end;i++){target[i*3]=attribute.getX(i);target[i*3+1]=attribute.getY(i);target[i*3+2]=attribute.getZ(i);}
  budget.copiedBytes+=(end-start)*12;const pause=budget.checkpoint();if(pause)await pause;
 }
 budget.check();return target;
}

/** Every source triangle retains its index and ordering in the collision worker. */
export async function copyTriangleIndices(attribute:BufferAttribute|null,vertexCount:number,budget:PreparationBudget){
 if(attribute?.array instanceof Uint32Array)return copyTypedArray(attribute.array,budget);
 budget.check();const target=new Uint32Array(attribute?.count??vertexCount),step=COPY_BYTES/4;
 for(let start=0;start<target.length;start+=step){
  const end=Math.min(target.length,start+step);
  if(attribute)target.set(attribute.array.subarray(start,end),start);else for(let i=start;i<end;i++)target[i]=i;
  budget.copiedBytes+=(end-start)*4;const pause=budget.checkpoint();if(pause)await pause;
 }
 budget.check();return target;
}
