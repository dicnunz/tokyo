import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchCompressedTile} from '../src/compressed-tiles.ts';
const source='https://assets.cms.plateau.reearth.io/tokyo.glb';
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));

test('429 and 503 wait for Retry-After and retry only the compressed endpoint',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});t.mock.method(Math,'random',()=>0);
 const calls:string[]=[],signals:(AbortSignal|null|undefined)[]=[],controller=new AbortController();
 t.mock.method(globalThis,'fetch',async(url:string,options:RequestInit)=>{calls.push(url);signals.push(options.signal);return calls.length<3?new Response('busy',{status:calls.length===1?429:503,headers:{'Retry-After':'1'}}):new Response('compressed');});
 const pending=fetchCompressedTile(source,{signal:controller.signal});await turn();
 assert.equal(calls.length,1);t.mock.timers.tick(999);await turn();assert.equal(calls.length,1);
 t.mock.timers.tick(1);await turn();assert.equal(calls.length,2);
 t.mock.timers.tick(1000);assert.equal(await(await pending).text(),'compressed');
 assert.equal(calls.length,3);assert.ok(calls.every(url=>url.startsWith('/api/tile?')&&url.endsWith('&wait=1')));
 assert.ok(signals.every(signal=>signal===controller.signal));
});

test('aborting a busy tile clears its retry timer and never falls back to a raw source',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});t.mock.method(Math,'random',()=>0);
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('busy',{status:429,headers:{'Retry-After':'1'}});});
 const controller=new AbortController(),pending=fetchCompressedTile(source,{signal:controller.signal});const rejected=assert.rejects(pending,{name:'AbortError'});
 await turn();controller.abort();await rejected;t.mock.timers.tick(60000);await turn();assert.equal(calls,1);
});

test('retry delays have a finite cap even with excessive or invalid Retry-After values',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});t.mock.method(Math,'random',()=>0);
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return calls<3?new Response('busy',{status:429,headers:{'Retry-After':calls===1?'999999':'not-a-date'}}):new Response('ready');});
 const pending=fetchCompressedTile(source);await turn();t.mock.timers.tick(4999);await turn();assert.equal(calls,1);
 t.mock.timers.tick(1);await turn();assert.equal(calls,2);
 t.mock.timers.tick(499);await turn();assert.equal(calls,2);
 t.mock.timers.tick(1);assert.equal(await(await pending).text(),'ready');
});

test('a cancelled request performs no HTTP work',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{assert.fail('aborted request must not reach the network');});
 const controller=new AbortController();controller.abort();await assert.rejects(fetchCompressedTile(source,{signal:controller.signal}),{name:'AbortError'});
});

test('genuine cache failures retain the original-source fallback',async t=>{
 const calls:string[]=[];t.mock.method(globalThis,'fetch',async(url:string)=>{calls.push(url);return calls.length===1?new Response('encoder unavailable',{status:502}):new Response('original bytes');});
 assert.equal(await(await fetchCompressedTile(source)).text(),'original bytes');assert.equal(calls.length,2);assert.equal(calls[1],source);
});

test('an encoder-provided original fallback is consumed once without a duplicate fetch',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('original bytes',{headers:{'X-Tokyo-Texture-Format':'original-fallback'}});});
 assert.equal(await(await fetchCompressedTile(source)).text(),'original bytes');assert.equal(calls,1);
});
