import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {createTileService,createSurveyServer} from '../server.mjs';

const source=(name:string)=>`https://assets.cms.plateau.reearth.io/${name}.glb`;
const key=(url:string)=>createHash('sha256').update('uastc2-mips-v1|'+url).digest('hex');
function gate(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return{promise,resolve};}
async function until(check:()=>boolean){const start=Date.now();while(!check()){assert.ok(Date.now()-start<3000,'queue reached its expected state');await new Promise(resolve=>setTimeout(resolve,2));}}
async function fixture(t:any,options:Record<string,unknown>={}){
 const directory=await mkdtemp(join(tmpdir(),'tokyo-tile-queue-')),downloads:string[]=[],started:string[]=[],encoders=new Map<string,ReturnType<typeof gate>>(),controllers:AbortController[]=[],requests:Promise<unknown>[]=[];
 let active=0,peak=0;
 const service=createTileService({cacheDirectory:directory,warn:()=>{},
  fetchSource:async(url:string)=>{downloads.push(url);return new Response('original:'+url);},
  encode:async({source:url,target}:any)=>{
   started.push(url);active++;peak=Math.max(peak,active);const control=gate();encoders.set(url,control);
   try{await control.promise;await writeFile(target,'encoded:'+url);}finally{active--;}
  },...options});
 const request=(name:string,wait=true)=>{const controller=new AbortController();controllers.push(controller);const promise=service.request(source(name),{wait,signal:controller.signal});promise.catch(()=>{});requests.push(promise);return{controller,promise};};
 t.after(async()=>{controllers.forEach(c=>c.abort());encoders.forEach(c=>c.resolve());await Promise.allSettled(requests);await until(()=>service.stats.encoding===0);await rm(directory,{recursive:true,force:true});});
 return{service,directory,downloads,started,encoders,request,peak:()=>peak};
}

test('wait requests respect fourteen-job admission and two encoders while cache hits stay immediate',async t=>{
 const f=await fixture(t);
 for(let i=0;i<14;i++)f.request('live-'+i);
 await until(()=>f.service.stats.jobs===14&&f.service.stats.encoding===2&&f.service.stats.queued===12);
 await writeFile(join(f.directory,key(source('excess'))+'.source'),'already cached raw');
 await assert.rejects(f.service.request(source('excess'),{wait:true}),{statusCode:429,retryAfter:1});
 assert.equal(f.downloads.length,14,'busy admission starts no hidden source download');
 assert.equal(f.service.stats.jobs,14);
 const raw=await f.service.request(source('excess'),{wait:false});assert.equal(raw.compressed,false);assert.equal(raw.body.toString(),'already cached raw');
 await writeFile(join(f.directory,key(source('cached'))+'.tile'),'already encoded');
 const cached=await f.service.request(source('cached'),{wait:true});assert.equal(cached.compressed,true);assert.equal(cached.body.toString(),'already encoded');
 assert.equal(f.service.stats.jobs,14);assert.equal(f.peak(),2);
});

test('same-URL subscribers share download and encoding, and one abort cannot cancel another',async t=>{
 const f=await fixture(t),a=f.request('shared'),b=f.request('shared');
 await until(()=>f.service.stats.encoding===1&&f.service.stats.subscribers===2);
 a.controller.abort();await assert.rejects(a.promise,{name:'AbortError'});
 assert.equal(f.service.stats.subscribers,1);assert.equal(f.started.length,1);assert.equal(f.downloads.length,1);
 f.encoders.get(source('shared'))!.resolve();const result=await b.promise;
 assert.equal(result.compressed,true);assert.equal(result.body.toString(),'encoded:'+source('shared'));
 const cached=await f.service.request(source('shared'),{wait:true});assert.equal(cached.compressed,true);
 assert.equal(f.started.length,1);assert.equal(f.downloads.length,1);
 assert.equal((await readFile(join(f.directory,key(source('shared'))+'.source'))).toString(),'original:'+source('shared'));
});

test('teleport cancellation removes abandoned queued work and advances the new destination',async t=>{
 const f=await fixture(t);f.request('active-a');f.request('active-b');
 await until(()=>f.service.stats.encoding===2);
 const stale=[f.request('old-a'),f.request('old-b')];f.request('still-live');
 await until(()=>f.service.stats.queued===3);
 stale.forEach(r=>r.controller.abort());await Promise.all(stale.map(r=>assert.rejects(r.promise,{name:'AbortError'})));
 assert.equal(f.service.stats.queued,1);assert.equal(f.service.stats.jobs,3);
 f.request('current-destination');await until(()=>f.service.stats.queued===2);
 f.encoders.get(source('active-a'))!.resolve();await until(()=>f.started.length===3);
 assert.equal(f.started[2],source('current-destination'));
 assert.ok(!f.started.includes(source('old-a'))&&!f.started.includes(source('old-b')));
 assert.equal((await readFile(join(f.directory,key(source('old-a'))+'.source'))).toString(),'original:'+source('old-a'),'cancelled queue work preserves its completed source cache');
});

test('last-subscriber abort stops an in-flight source download and releases admission',async t=>{
 let sourceSignal:AbortSignal|undefined;
 const f=await fixture(t,{fetchSource:(_url:string,{signal}:any)=>new Promise((_resolve,reject)=>{sourceSignal=signal;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
 const request=f.request('still-downloading');await until(()=>!!sourceSignal);
 request.controller.abort();await assert.rejects(request.promise,{name:'AbortError'});
 assert.equal(sourceSignal!.aborted,true);assert.equal(f.service.stats.jobs,0);assert.equal(f.started.length,0);
});

test('an active encoder may finish and cache after its last subscriber leaves',async t=>{
 const f=await fixture(t),request=f.request('finish-cache');await until(()=>f.started.length===1);
 request.controller.abort();await assert.rejects(request.promise,{name:'AbortError'});
 assert.equal(f.service.stats.encoding,1);assert.equal(f.service.stats.jobs,1);
 f.encoders.get(source('finish-cache'))!.resolve();await until(()=>f.service.stats.encoding===0);
 const cached=await f.service.request(source('finish-cache'),{wait:true});assert.equal(cached.compressed,true);assert.equal(f.started.length,1);
});

test('recent requests cannot indefinitely starve an older live viewer',async t=>{
 const f=await fixture(t,{concurrency:1});f.request('active');await until(()=>f.started.length===1);
 f.request('old-live');await until(()=>f.service.stats.queued===1);
 let active=source('active');
 for(let i=0;i<4&&!f.started.includes(source('old-live'));i++){
  f.request('new-'+i);await until(()=>f.service.stats.queued>=2);
  const count=f.started.length;f.encoders.get(active)!.resolve();await until(()=>f.started.length>count);active=f.started.at(-1)!;
 }
 assert.ok(f.started.includes(source('old-live')),'an oldest-live turn bounds displacement by continuous newer requests');
});

test('HTTP disconnects detach queued subscribers and busy responses carry retry backpressure',async t=>{
 const f=await fixture(t,{maxJobs:3});f.request('active-a');f.request('active-b');await until(()=>f.service.stats.encoding===2);
 const server=createSurveyServer(f.service);server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address() as {port:number},base=`http://127.0.0.1:${address.port}/api/tile?wait=1&url=`;
 t.after(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
 const controller=new AbortController(),response=fetch(base+encodeURIComponent(source('http-queued')),{signal:controller.signal});response.catch(()=>{});
 await until(()=>f.service.stats.queued===1);
 const busy=await fetch(base+encodeURIComponent(source('http-overflow')));assert.equal(busy.status,429);assert.equal(busy.headers.get('Retry-After'),'1');await busy.arrayBuffer();
 assert.equal(f.downloads.length,3);
 controller.abort();await assert.rejects(response,{name:'AbortError'});await until(()=>f.service.stats.jobs===2);
 assert.equal(f.service.stats.queued,0);
 const unsupported=await fetch(base+encodeURIComponent('https://example.com/tile.glb'));assert.equal(unsupported.status,400);await unsupported.arrayBuffer();
});

test('a genuine encoder failure returns the unchanged cached original',async t=>{
 const f=await fixture(t,{encode:async()=>{throw Error('encoder unavailable');}});
 const result=await f.request('failure').promise;
 assert.equal(result.compressed,false);assert.equal(result.body.toString(),'original:'+source('failure'));
 assert.equal((await readFile(join(f.directory,key(source('failure'))+'.source'))).toString(),result.body.toString());
 assert.equal(f.service.stats.jobs,0);
});
