import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {runtimeTools,createSurveyServer} from '../server.mjs';

test('runtime tools honor overrides and use repository venv before system Python',()=>{
 assert.deepEqual(runtimeTools({TOKYO_PYTHON:'/custom/python',TOKYO_TEXTURE_ENCODER:'/custom/toktx'},'/repo',()=>true),{python:'/custom/python',encoder:'/custom/toktx'});
 assert.deepEqual(runtimeTools({PATH:'/tools'},'/repo',(path:string)=>['/repo/.venv/bin/python','/tools/basisu'].includes(path)),{python:'/repo/.venv/bin/python',encoder:'/tools/basisu'});
 assert.deepEqual(runtimeTools({PATH:''},'/repo',()=>false),{python:'python3',encoder:'basisu'});
});

test('omitted optional demo returns an actionable 404',async t=>{
 const previous=process.env.TOKYO_DEMO_VIDEO;delete process.env.TOKYO_DEMO_VIDEO;
 t.after(()=>{if(previous===undefined)delete process.env.TOKYO_DEMO_VIDEO;else process.env.TOKYO_DEMO_VIDEO=previous;});
 const server=createSurveyServer();server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
 const address=server.address() as {port:number};
 const response=await fetch(`http://127.0.0.1:${address.port}/demo.mp4`);
 assert.equal(response.status,404);assert.match((await response.json()).error,/TOKYO_DEMO_VIDEO/);
});
