import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
const aborted=()=>new DOMException('View changed before imagery was ready','AbortError');

/** On-demand source reprojection stays outside the animation thread.
 * Active work may finish into the disk cache after its subscribers leave.
 * Await close() when the caller needs proof that all physical workers stopped.
 */
export function createOrthoService({python,script,cacheDirectory,workers=2,maxJobs=12,workerTimeoutMs=90000,workerStopTimeoutMs=1000}){
 for(const [name,value] of Object.entries({workers,maxJobs,workerTimeoutMs,workerStopTimeoutMs})){
  if(!Number.isSafeInteger(value)||value<1)throw new RangeError(`${name} must be a positive integer`);
 }
 const jobs=new Map(),pool=[];let sequence=0,turn=0,closed=false,closing;
 const assertOpen=signal=>{signal?.throwIfAborted();if(closed)throw aborted();};
 function settle(job,error,body){
  if(job.settled)return;job.settled=true;
  if(jobs.get(job.key)===job)jobs.delete(job.key);
  for(const sub of job.subscribers){sub.signal?.removeEventListener('abort',sub.abort);error?sub.reject(error):sub.resolve(body);}
  job.subscribers.clear();
 }
 function stop(worker){
  if(worker.exited)return;
  worker.process.kill('SIGTERM');
  // A stuck native operation can ignore SIGTERM. Keep its pool slot occupied
  // until close confirms exit, so replacement cannot exceed the process limit.
  worker.killTimer??=setTimeout(()=>{if(!worker.exited)worker.process.kill('SIGKILL');},workerStopTimeoutMs);
  worker.killTimer.unref();
 }
 function fail(worker,error){
  if(worker.failed)return;worker.failed=true;clearTimeout(worker.timer);
  if(worker.job)settle(worker.job,error);worker.job=null;
  stop(worker);
 }
 function launch(){
  const child=spawn(python,[script,'--worker','--cache-dir',resolve(cacheDirectory,'sources')],{stdio:['pipe','pipe','pipe'],env:{...process.env,GDAL_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}});
  let finished;const done=new Promise(resolve=>{finished=resolve;});
  const worker={process:child,job:null,timer:null,killTimer:null,error:'',failed:false,exited:false,reading:false,done};pool.push(worker);
  const reader=createInterface({input:child.stdout});
  const stopped=code=>Error('Ortho worker stopped: '+code+' '+worker.error.slice(-240));
  child.stderr.on('data',data=>{worker.error=(worker.error+data.toString()).slice(-4000);});
  child.on('error',error=>fail(worker,error));child.stdin.on('error',error=>fail(worker,error));
  child.on('exit',code=>{worker.exited=true;fail(worker,stopped(code));});
  child.on('close',code=>{
   worker.exited=true;fail(worker,stopped(code));clearTimeout(worker.timer);clearTimeout(worker.killTimer);reader.close();
   const index=pool.indexOf(worker);if(index>=0)pool.splice(index,1);finished();pump();
  });
  reader.on('line',async line=>{
   const job=worker.job;if(!job||worker.failed||worker.reading||closed)return;
   let result;
   try{result=JSON.parse(line);if(!result||typeof result!=='object'||!('id' in result))throw Error('missing response ID');}
   catch(error){fail(worker,Error('Invalid ortho worker protocol: '+error.message));return;}
   // A delayed/duplicate reply must never release a different request's slot.
   if(result.id!==job.id)return;
   if(typeof result.ok!=='boolean'){fail(worker,Error('Invalid ortho worker protocol: missing result status'));return;}
   worker.reading=true;
   try{
    if(!result.ok)throw Error(result.error||'Native imagery unavailable');
    const body=await readFile(job.output);
    if(worker.job===job&&!worker.failed&&!closed)settle(job,null,body);
   }catch(error){if(worker.job===job&&!worker.failed&&!closed)settle(job,error);}
   finally{
    if(worker.job===job){clearTimeout(worker.timer);worker.job=null;worker.reading=false;pump();}
   }
  });
  return worker;
 }
 function pump(){
  if(closed)return;
  for(;;){
   const pending=[...jobs.values()].filter(j=>!j.active&&j.subscribers.size);
   if(!pending.length)return;
   let worker=pool.find(w=>!w.job&&!w.failed);if(!worker&&pool.length<workers)worker=launch();if(!worker)return;
   const oldest=turn++%4===3;pending.sort((a,b)=>oldest?a.created-b.created:b.requested-a.requested);const job=pending[0];job.active=true;worker.job=job;
   worker.timer=setTimeout(()=>fail(worker,Error('Ortho worker timed out')),workerTimeoutMs);
   try{worker.process.stdin.write(JSON.stringify({id:job.id,z:job.z,x:job.x,y:job.y,output:job.output})+'\n',error=>{if(error)fail(worker,error);});}
   catch(error){fail(worker,error);}
  }
 }
 return{
  async request(z,x,y,signal){
   assertOpen(signal);
   if(z!==19||![x,y].every(v=>Number.isSafeInteger(v)&&v>=0&&v<2**z))throw Object.assign(Error('Invalid ortho tile'),{statusCode:400});
   const key=`${z}/${x}/${y}`,output=resolve(cacheDirectory,'tiles',key+'.png');let data;
   try{data=await readFile(output);}catch(error){if(error.code!=='ENOENT')throw error;}
   assertOpen(signal);if(data)return data;
   await mkdir(resolve(cacheDirectory,'tiles',String(z),String(x)),{recursive:true});assertOpen(signal);
   let job=jobs.get(key);
   if(!job){
    if(jobs.size>=maxJobs)throw Object.assign(Error('Native imagery queue is busy'),{statusCode:429,retryAfter:1});
    const created=++sequence;job={id:key+':'+created,key,z,x,y,output,subscribers:new Set(),active:false,settled:false,created,requested:created};jobs.set(key,job);
   }
   job.requested=++sequence;
   return new Promise((resolve,reject)=>{
    const sub={resolve,reject,signal,abort:null};sub.abort=()=>{
     job.subscribers.delete(sub);signal?.removeEventListener('abort',sub.abort);reject(signal?.reason||aborted());
     if(!job.active&&!job.subscribers.size)settle(job);
    };
    job.subscribers.add(sub);signal?.addEventListener('abort',sub.abort,{once:true});if(signal?.aborted)sub.abort();else pump();
   });
  },
  get stats(){return{jobs:jobs.size,active:pool.filter(w=>w.job).length,workers:pool.length};},
  close(){
   if(closing)return closing;closed=true;
   for(const job of jobs.values())settle(job,aborted());
   const stopped=pool.map(worker=>worker.done);for(const worker of pool)fail(worker,aborted());
   closing=Promise.all(stopped).then(()=>undefined);return closing;
  },
 };
}
