import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createOrthoService} from '../scripts/ortho-service.mjs';

const pause=(ms=3)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean|Promise<boolean>,message='worker reached the expected state',timeout=4000){
 const start=Date.now();while(!await check()){assert.ok(Date.now()-start<timeout,message);await pause();}
}
const tileKey=(x:number)=>`19/${x}/1`;
const image=(x:number)=>Buffer.concat([Buffer.from([137,80,78,71,0,255]),Buffer.from(tileKey(x))]);
function alive(pid:number){try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}}

/** Exercises the same line-delimited JSON/file protocol as the persistent Python worker. */
async function fixture(t:any,options:Record<string,unknown>={},modes:Record<number,string>={}){
 const directory=await mkdtemp(join(tmpdir(),'tokyo-ortho-service-')),script=join(directory,'worker.mjs'),eventsPath=join(directory,'events.jsonl');
 await writeFile(eventsPath,'');
 await writeFile(join(directory,'modes.json'),JSON.stringify(modes));
 await writeFile(script,`
import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(fileURLToPath(import.meta.url)),modes=JSON.parse(readFileSync(join(root,'modes.json'),'utf8'));
const log=event=>appendFileSync(join(root,'events.jsonl'),JSON.stringify({...event,pid:process.pid})+'\\n');
const wait=async path=>{while(!existsSync(path))await new Promise(resolve=>setTimeout(resolve,3));};
let ignoringTerm=false;
process.on('SIGTERM',()=>{log({type:'term'});if(!ignoringTerm)process.exit(0);});
log({type:'ready'});
createInterface({input:process.stdin}).on('line',async line=>{
 const job=JSON.parse(line),mode=modes[job.x];ignoringTerm=mode==='ignore-term';log({type:'start',x:job.x,id:job.id});
 if(mode==='ignore-term')return;
 await wait(join(root,job.x+'.go'));
 if(mode==='crash'){process.stderr.write('fixture reprojection failed');process.exit(17);}
 if(mode==='malformed'){process.stdout.write('broken protocol\\n');return;}
 if(mode==='failure'){process.stdout.write(JSON.stringify({id:job.id,ok:false,error:'fixture missing coverage'})+'\\n');return;}
 writeFileSync(job.output,Buffer.concat([Buffer.from([137,80,78,71,0,255]),Buffer.from(job.z+'/'+job.x+'/'+job.y)]));
 if(mode==='stale-id'){
  process.stdout.write(JSON.stringify({id:'stale-'+job.id,ok:true})+'\\n');log({type:'stale',x:job.x});
  await wait(join(root,job.x+'.accept'));
 }
 process.stdout.write(JSON.stringify({id:job.id,ok:true})+'\\n');
 log({type:'finish',x:job.x});
});
`);
 const service=createOrthoService({python:process.execPath,script,cacheDirectory:join(directory,'cache'),workerStopTimeoutMs:100,...options});
 const pending:Promise<Buffer>[]=[];
 const request=(x:number,signal?:AbortSignal)=>{const promise=service.request(19,x,1,signal);promise.catch(()=>{});pending.push(promise);return promise;};
 const events=async()=>{const data=await readFile(eventsPath,'utf8');return data.trim()?data.trim().split('\n').map(line=>JSON.parse(line)):[];};
 const starts=async()=> (await events()).filter(event=>event.type==='start');
 const started=async(x:number)=>until(async()=> (await starts()).some(event=>event.x===x),`tile ${x} started in the child process`);
 const release=(x:number)=>writeFile(join(directory,x+'.go'),'');
 const seed=async(x:number)=>{const output=join(directory,'cache','tiles','19',String(x),'1.png');await mkdir(join(directory,'cache','tiles','19',String(x)),{recursive:true});await writeFile(output,image(x));};
 t.after(async()=>{
  await service.close();await Promise.allSettled(pending);
  const pids=[...new Set((await events()).map(event=>event.pid))] as number[];
  await until(()=>pids.every(pid=>!alive(pid)),'all fixture child processes exited');
  await rm(directory,{recursive:true,force:true});
 });
 return{service,directory,request,events,starts,started,release,seed};
}

test('ortho admission bounds twelve live jobs and two actual processes, while cache bypasses a full queue',async t=>{
 const f=await fixture(t);
 for(let x=1;x<=12;x++)f.request(x);
 await until(()=>f.service.stats.jobs===12&&f.service.stats.active===2);
 await until(async()=> (await f.starts()).length===2);
 await assert.rejects(f.request(13),{statusCode:429,retryAfter:1});
 await f.seed(100);assert.deepEqual(await f.request(100),image(100));
 assert.deepEqual(f.service.stats,{jobs:12,active:2,workers:2});
 assert.equal(new Set((await f.starts()).map(event=>event.pid)).size,2);
});

test('same-tile subscribers share a worker; one abort preserves another and the exact cached bytes',async t=>{
 const f=await fixture(t),controller=new AbortController(),a=f.request(1,controller.signal),b=f.request(1);
 await f.started(1);await until(()=>f.service.stats.jobs===1);
 controller.abort();await assert.rejects(a,{name:'AbortError'});
 assert.equal(f.service.stats.active,1);
 await f.release(1);assert.deepEqual(await b,image(1));
 assert.deepEqual(await f.request(1),image(1));assert.equal((await f.starts()).length,1);
 assert.equal(f.service.stats.jobs,0);assert.equal(f.service.stats.workers,1);
});

test('queued subscriber abort frees admission only after its last subscriber leaves and advances the current view',async t=>{
 const f=await fixture(t,{workers:1,maxJobs:3}),active=f.request(1);await f.started(1);
 const first=new AbortController(),last=new AbortController(),a=f.request(2,first.signal),b=f.request(2,last.signal);f.request(3);
 await until(()=>f.service.stats.jobs===3);
 first.abort();await assert.rejects(a,{name:'AbortError'});assert.equal(f.service.stats.jobs,3);
 last.abort();await assert.rejects(b,{name:'AbortError'});assert.equal(f.service.stats.jobs,2);
 const current=f.request(4);await until(()=>f.service.stats.jobs===3);
 await f.release(1);await active;await f.started(4);
 assert.deepEqual((await f.starts()).map(event=>event.x),[1,4]);
 await f.release(4);assert.deepEqual(await current,image(4));
});

test('an active tile without subscribers may finish into the reusable disk cache',async t=>{
 const f=await fixture(t),controller=new AbortController(),pending=f.request(1,controller.signal);await f.started(1);
 controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.equal(f.service.stats.active,1);
 await f.release(1);await until(()=>f.service.stats.jobs===0);
 assert.deepEqual(await f.request(1),image(1));assert.equal((await f.starts()).length,1);
});

test('old live requests receive a dispatch turn under continuous newer requests',async t=>{
 const f=await fixture(t,{workers:1});let running=f.request(1),active=1;await f.started(1);f.request(2);await until(()=>f.service.stats.jobs===2);
 for(let x=3;x<=6&&!(await f.starts()).some(event=>event.x===2);x++){
  const latest=f.request(x);await until(()=>f.service.stats.jobs>=3);const count=(await f.starts()).length;
  await f.release(active);await running;await until(async()=> (await f.starts()).length>count);
  active=(await f.starts()).at(-1).x;running=active===x?latest:Promise.resolve(image(active));
 }
 assert.ok((await f.starts()).some(event=>event.x===2),'an oldest-live dispatch prevents starvation');
 assert.ok((await f.starts()).findIndex(event=>event.x===2)<=3);
});

test('a mismatched response ID cannot complete a tile or release its worker',async t=>{
 const f=await fixture(t,{workers:1},{1:'stale-id'});let completed=false;
 const pending=f.request(1).finally(()=>{completed=true;});await f.started(1);await f.release(1);
 await until(async()=> (await f.events()).some(event=>event.type==='stale'));await pause(30);
 assert.equal(completed,false,'the response must belong to the active request');assert.equal(f.service.stats.active,1);
 await writeFile(join(f.directory,'1.accept'),'');assert.deepEqual(await pending,image(1));
});

test('shutdown rejects disk lookups already in flight and never leaves newly queued promises',async t=>{
 const f=await fixture(t);let settled=false;
 const pending=f.request(1).finally(()=>{settled=true;});pending.catch(()=>{});
 await f.service.close();await until(()=>settled,'in-flight request rejects after shutdown',1000);
 await assert.rejects(pending,{name:'AbortError'});assert.deepEqual(f.service.stats,{jobs:0,active:0,workers:0});
 await assert.rejects(f.request(2),{name:'AbortError'});
});

test('shutdown also cancels an in-flight cache read without starting a worker',async t=>{
 const f=await fixture(t);await f.seed(1);const pending=f.request(1);await f.service.close();
 await assert.rejects(pending,{name:'AbortError'});assert.equal((await f.starts()).length,0);
});

test('shutdown rejects active and queued subscribers and waits for its child processes to exit',async t=>{
 const f=await fixture(t),requests=[f.request(1),f.request(2),f.request(3)];
 await until(async()=> (await f.starts()).length===2);
 const pids=(await f.starts()).map(event=>event.pid);await f.service.close();
 await Promise.all(requests.map(promise=>assert.rejects(promise,{name:'AbortError'})));
 assert.ok(pids.every(pid=>!alive(pid)),'close resolves only after physical child processes stop');
 assert.deepEqual(f.service.stats,{jobs:0,active:0,workers:0});await f.service.close();
});

test('a crashed worker rejects its job and a replacement serves queued work without losing cache',async t=>{
 const f=await fixture(t,{workers:1},{1:'crash'}),failed=f.request(1);await f.started(1);
 const next=f.request(2);await until(()=>f.service.stats.jobs===2);await f.release(1);
 await assert.rejects(failed,/17.*fixture reprojection failed/);await f.started(2);
 const starts=await f.starts();assert.notEqual(starts[0].pid,starts[1].pid);assert.equal(alive(starts[0].pid),false);
 assert.equal(f.service.stats.workers,1);await f.release(2);assert.deepEqual(await next,image(2));
 assert.deepEqual(await f.request(2),image(2));assert.equal((await f.starts()).length,2);
});

test('a malformed response retires the desynchronized worker before dispatching another tile',async t=>{
 const f=await fixture(t,{workers:1},{1:'malformed'}),failed=f.request(1);await f.started(1);
 const next=f.request(2);await until(()=>f.service.stats.jobs===2);await f.release(1);
 await assert.rejects(failed,/protocol|JSON/i);await f.started(2);
 const starts=await f.starts();assert.notEqual(starts[0].pid,starts[1].pid);assert.equal(alive(starts[0].pid),false);
 await f.release(2);assert.deepEqual(await next,image(2));
});

test('a reported coverage failure keeps the healthy persistent worker available for the next tile',async t=>{
 const f=await fixture(t,{workers:1},{1:'failure'}),failed=f.request(1);await f.started(1);
 const next=f.request(2);await until(()=>f.service.stats.jobs===2);await f.release(1);
 await assert.rejects(failed,/fixture missing coverage/);await f.started(2);
 const starts=await f.starts();assert.equal(starts[0].pid,starts[1].pid);
 await f.release(2);assert.deepEqual(await next,image(2));
});

test('a missing worker executable rejects admitted work and releases the failed process slot',async t=>{
 const f=await fixture(t,{workers:1,python:join(tmpdir(),'tokyo-ortho-no-such-executable')});
 await assert.rejects(f.request(1),{code:'ENOENT'});await until(()=>f.service.stats.workers===0);
 assert.deepEqual(f.service.stats,{jobs:0,active:0,workers:0});
});

test('timed-out workers that ignore termination are reaped before pool capacity is reused',async t=>{
 const f=await fixture(t,{workers:1,workerTimeoutMs:1000,workerStopTimeoutMs:50},{1:'ignore-term'}),failed=f.request(1);await f.started(1);
 const next=f.request(2);await assert.rejects(failed,/timed out/i);await f.started(2);
 const starts=await f.starts();assert.equal(alive(starts[0].pid),false);assert.notEqual(starts[0].pid,starts[1].pid);
 assert.equal(f.service.stats.workers,1);await f.release(2);assert.deepEqual(await next,image(2));
});
