import http from 'node:http';
import {createOrthoService} from './scripts/ortho-service.mjs';
import {readFile,writeFile,mkdir,stat,rename,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {createWriteStream,createReadStream,existsSync} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {resolve,extname,delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
const root=fileURLToPath(new URL('./dist/',import.meta.url)),port=Number(process.env.PORT||5173),cache=new Map();
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.png':'image/png','.jpg':'image/jpeg','.glb':'model/gltf-binary','.gltf':'model/gltf+json','.ktx2':'image/ktx2','.bin':'application/octet-stream'};
const project=fileURLToPath(new URL('./',import.meta.url));
const tileCache=resolve(project,'work/compressed-tiles');
export function runtimeTools(env=process.env,directory=project,exists=existsSync){
 const localPython=resolve(directory,'.venv/bin/python');
 const python=env.TOKYO_PYTHON||(exists(localPython)?localPython:'python3');
 const candidates=(env.PATH||'').split(delimiter).filter(Boolean).map(folder=>resolve(folder,'basisu'));
 candidates.push('/opt/homebrew/bin/basisu','/usr/local/bin/basisu');
 const encoder=env.TOKYO_TEXTURE_ENCODER||candidates.find(exists)||'basisu';
 return{python,encoder};
}
const {python,encoder}=runtimeTools();
const run=promisify(execFile);
const tileKey=source=>createHash('sha256').update('uastc2-mips-v1|'+source).digest('hex');
const cancelled=()=>new DOMException('Tile request no longer has a viewer','AbortError');
async function cachedFile(file){try{return await readFile(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});return{promise,resolve,reject};}

/** Bounded work is owned by live HTTP subscribers, not by past camera positions. */
export function createTileService({cacheDirectory=tileCache,maxJobs=14,concurrency=2,fetchSource=fetch,
 encode=async({sourceFile,target})=>run(python,[resolve(project,'scripts/compress_tile.py'),sourceFile,target,encoder],{timeout:240000,maxBuffer:1048576}),
 warn=message=>console.warn('Original survey tile fallback:',message)}={}){
 if(!Number.isInteger(concurrency)||concurrency<1||!Number.isInteger(maxJobs)||maxJobs<concurrency)throw new RangeError('Invalid tile queue limits');
 const jobs=new Map();let encoding=0,sequence=0,dispatches=0;
 const forget=job=>{if(jobs.get(job.key)===job)jobs.delete(job.key);};
 function finish(job,result,error){
  job.state='done';forget(job);
  if(error){job.raw.reject(error);job.finished.reject(error);}else job.finished.resolve(result);
 }
 function prune(job){
  if(job.subscribers.size||job.state==='encoding'||job.state==='done'||job.state==='cancelled')return;
  job.state='cancelled';forget(job);job.controller.abort(cancelled());
  job.raw.reject(job.controller.signal.reason);job.finished.reject(job.controller.signal.reason);
 }
 function pump(){
  while(encoding<concurrency){
   const ready=[...jobs.values()].filter(job=>job.state==='queued'&&job.subscribers.size);
   if(!ready.length)return;
   // Three recent-request turns followed by the oldest live job. New camera
   // requests move forward without indefinitely displacing another live viewer.
   const oldest=dispatches++%4===3;
   ready.sort((a,b)=>oldest?a.created-b.created:b.requested-a.requested);
   const job=ready[0];job.state='encoding';encoding++;
   void(async()=>{
    try{
     let result;
     try{await encode({source:job.source,sourceFile:job.sourceFile,target:job.target});result={body:await readFile(job.target),compressed:true};}
     catch(error){warn(String(error.message??error).slice(0,160));result={body:job.body,compressed:false};}
     finish(job,result);
    }finally{encoding--;pump();}
   })();
  }
 }
 function subscribe(job,wait,signal){
  signal?.throwIfAborted();
  const subscriber={};job.subscribers.add(subscriber);job.requested=++sequence;
  return new Promise((resolve,reject)=>{
   let done=false;
   const settle=(callback,value)=>{
    if(done)return;done=true;signal?.removeEventListener('abort',abort);job.subscribers.delete(subscriber);
    prune(job);callback(value);pump();
   };
   const abort=()=>settle(reject,signal.reason??cancelled());
   signal?.addEventListener('abort',abort,{once:true});
   const result=wait?job.finished.promise:job.raw.promise.then(body=>({body,compressed:false}));
   result.then(value=>settle(resolve,value),error=>settle(reject,error));
  });
 }
 async function load(job){
  try{
   let body=await cachedFile(job.sourceFile);job.controller.signal.throwIfAborted();
   if(!body){
    const response=await fetchSource(job.source,{signal:AbortSignal.any([job.controller.signal,AbortSignal.timeout(30000)]),redirect:'error'});
    if(!response.ok)throw Error('Official tile source returned '+response.status);
    body=Buffer.from(await response.arrayBuffer());job.controller.signal.throwIfAborted();
    if(body.length>128*1024*1024)throw Error('Tile exceeds cache limit');
    // A cancelled and immediately re-requested source cannot expose a partially
    // written cache entry to the new subscriber. Existing cache files stay intact.
    const temporary=job.sourceFile+'.partial-'+randomUUID();
    try{await writeFile(temporary,body);await rename(temporary,job.sourceFile);}finally{await unlink(temporary).catch(()=>{});}
   }
   job.controller.signal.throwIfAborted();job.body=body;job.state='queued';job.raw.resolve(body);pump();
  }catch(error){if(job.state!=='cancelled')finish(job,null,error);pump();}
 }
 return{
  get stats(){return{jobs:jobs.size,encoding,queued:[...jobs.values()].filter(job=>job.state==='queued').length,loading:[...jobs.values()].filter(job=>job.state==='loading').length,subscribers:[...jobs.values()].reduce((n,job)=>n+job.subscribers.size,0)};},
  async request(source,{wait=false,signal}={}){
   signal?.throwIfAborted();await mkdir(cacheDirectory,{recursive:true});signal?.throwIfAborted();
   const key=tileKey(source),target=resolve(cacheDirectory,key+'.tile'),sourceFile=resolve(cacheDirectory,key+'.source');
   const cached=await cachedFile(target);signal?.throwIfAborted();if(cached)return{body:cached,compressed:true};
   // Non-waiting requests may still read an existing raw cache entry when busy.
   // wait=1 never bypasses admission or silently floods the GPU with raw images.
   if(!wait&&!jobs.has(key)&&jobs.size>=maxJobs){const raw=await cachedFile(sourceFile);signal?.throwIfAborted();if(raw)return{body:raw,compressed:false};}
   let job=jobs.get(key),created=false;
   if(!job){
    if(jobs.size>=maxJobs){const error=Error('Texture conversion queue is busy');error.statusCode=429;error.retryAfter=1;throw error;}
    job={key,source,target,sourceFile,controller:new AbortController(),subscribers:new Set(),raw:deferred(),finished:deferred(),state:'loading',created:++sequence,requested:sequence,body:null};
    jobs.set(key,job);created=true;
   }
   const result=subscribe(job,wait,signal);if(created)void load(job);return result;
  },
 };
}
const tileService=createTileService();
const orthoService=createOrthoService({python,script:resolve(project,'scripts/tokyo_ortho.py'),cacheDirectory:resolve(project,'work/native-ortho-v1')});
export function createSurveyServer(tiles=tileService){return http.createServer(async(req,res)=>{try{
 const url=new URL(req.url,'http://127.0.0.1');
 const ortho=/^\/api\/tokyo-ortho\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(url.pathname);
 if(ortho&&req.method==='GET'){
  const controller=new AbortController(),disconnect=()=>controller.abort(cancelled());req.once('aborted',disconnect);res.once('close',disconnect);
  let body;try{body=await orthoService.request(Number(ortho[1]),Number(ortho[2]),Number(ortho[3]),controller.signal);}finally{req.off('aborted',disconnect);res.off('close',disconnect);}
  if(controller.signal.aborted||res.destroyed)return;
  res.writeHead(200,{'Content-Type':'image/png','Content-Length':body.length,'Cache-Control':'public, max-age=31536000, immutable','X-Tokyo-Source':'Tokyo Digital Twin 20 cm orthophoto; CC BY 4.0'});res.end(body);return;
 }
 if(url.pathname==='/api/tile'&&req.method==='GET'){
  const source=new URL(url.searchParams.get('url')||'');
  const hosts=new Set(['assets.cms.plateau.reearth.io','assets.cms.plateauview.mlit.go.jp','api.plateauview.mlit.go.jp']);
  if(source.protocol!=='https:'||!hosts.has(source.hostname)||source.username||source.password||(source.port&&source.port!=='443')||!(/\.(b3dm|glb)$/i.test(source.pathname))){res.writeHead(400);res.end('Unsupported official tile URL');return;}
  const controller=new AbortController(),disconnect=()=>controller.abort(cancelled());
  req.once('aborted',disconnect);res.once('close',disconnect);
  let result;
  try{if(req.aborted||res.destroyed)disconnect();result=await tiles.request(source.href,{wait:url.searchParams.get('wait')==='1',signal:controller.signal});}
  finally{req.off('aborted',disconnect);res.off('close',disconnect);}
  if(controller.signal.aborted||res.destroyed)return;
  res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':result.body.length,'Cache-Control':result.compressed?'public, max-age=31536000, immutable':'no-store','X-Tokyo-Texture-Format':result.compressed?'ktx2-uastc':'original-fallback'});res.end(result.body);return;
 }

 if(url.pathname==='/demo.mp4'&&['GET','HEAD'].includes(req.method)){
  if(!process.env.TOKYO_DEMO_VIDEO)throw Object.assign(Error('Demo video is not installed. Set TOKYO_DEMO_VIDEO to a local MP4 file.'),{statusCode:404});
  const file=resolve(process.env.TOKYO_DEMO_VIDEO),info=await stat(file),range=req.headers.range;
  let start=0,end=info.size-1,code=200;
  if(range){const match=/^bytes=(\d+)-(\d*)$/.exec(range);if(!match){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return;}start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),info.size-1):info.size-1;if(start>end||start>=info.size){res.writeHead(416,{'Content-Range':`bytes */${info.size}`});res.end();return;}code=206;}
  const headers={'Content-Type':'video/mp4','Content-Length':end-start+1,'Accept-Ranges':'bytes'};if(code===206)headers['Content-Range']=`bytes ${start}-${end}/${info.size}`;
  res.writeHead(code,headers);if(req.method==='HEAD')res.end();else createReadStream(file,{start,end}).pipe(res);return;
 }
 if(req.method==='POST'&&['/api/cinema-export','/api/cinema-video'].includes(url.pathname)){
  const origin=req.headers.origin;if(origin&&origin!==`http://127.0.0.1:${port}`){res.writeHead(403);res.end();return;}
  const folder=fileURLToPath(new URL('./work/',import.meta.url));await mkdir(folder,{recursive:true});
  const filename=url.pathname.endsWith('export')?'tokyo-city.glb':'tokyo-flight.h264';
  let received=0;req.on('data',chunk=>{received+=chunk.length;if(received>800*1024*1024)req.destroy(Error('Capture exceeds limit'));});
  await pipeline(req,createWriteStream(resolve(folder,filename)));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({saved:filename,bytes:received}));return;
 }
 if(url.pathname==='/api/geoid'){
  const lat=Number(url.searchParams.get('lat')),lon=Number(url.searchParams.get('lon'));
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<20||lat>46||lon<122||lon>154){res.writeHead(400);res.end('Invalid coordinates');return;}
  const key=`${lat.toFixed(4)},${lon.toFixed(4)}`;let body=cache.get(key);
  if(!body){const response=await fetch(`https://vldb.gsi.go.jp/sokuchi/surveycalc/geoid/calcgh2011/cgi/geoidcalc.pl?outputType=json&latitude=${lat.toFixed(8)}&longitude=${lon.toFixed(8)}`,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('GSI geoid service unavailable');body=await response.text();if(JSON.parse(body).OutputData?.geoidHeight)cache.set(key,body);}
  res.writeHead(200,{'Content-Type':'application/json'});res.end(body);return;
 }
 const path=resolve(root,'.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
 if(!path.startsWith(root)){res.writeHead(403);res.end();return;}
 const info=await stat(path);if(!info.isFile()){res.writeHead(404);res.end();return;}
 const etag='W/"'+info.size.toString(16)+'-'+Math.floor(info.mtimeMs).toString(16)+'"';
 const headers={'Content-Type':mime[extname(path)]||'application/octet-stream','Cache-Control':path.includes('/assets/')?'public, max-age=31536000, immutable':'no-cache','ETag':etag,'Content-Length':info.size};
 if(req.headers['if-none-match']===etag){res.writeHead(304,headers);res.end();return;}
 res.writeHead(200,headers);if(req.method==='HEAD')res.end();else createReadStream(path).on('error',()=>res.destroy()).pipe(res);
 }catch(error){if(res.destroyed||res.writableEnded)return;const headers={'Content-Type':'application/json'};if(error.retryAfter)headers['Retry-After']=String(error.retryAfter);res.writeHead(error.statusCode??(error.code==='ENOENT'?404:502),headers);res.end(JSON.stringify({error:error.message}));}});}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
const server=createSurveyServer();
server.on('close',()=>orthoService.close());
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{server.close();await orthoService.close();process.exit(0);});
server.listen(port,'127.0.0.1',()=>{const url=`http://127.0.0.1:${port}`;console.log(`Tokyo Survey Atlas: ${url}\nLeave this terminal open while exploring. Ctrl+C stops the site.`);if(process.env.TOKYO_OPEN==='1')execFile('open',[url]);});
server.on('error',async error=>{if(error.code==='EADDRINUSE'){try{const text=await(await fetch(`http://127.0.0.1:${port}`,{signal:AbortSignal.timeout(2000)})).text();if(text.includes('Tokyo · Survey Atlas')){if(process.env.TOKYO_OPEN==='1')execFile('open',[`http://127.0.0.1:${port}`]);console.log('Tokyo is already running.');return;}}catch{}}console.error(error.message);process.exitCode=1;});
}
