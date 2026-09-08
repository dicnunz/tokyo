import test from 'node:test';
import assert from 'node:assert/strict';
import {FrameMonitor} from '../src/performance.ts';

function graphics(){
 let lost=false,generation=0,next=0,calls=0,available=false;
 const extensions:object[]=[];
 const check=(query?:{generation:number})=>{assert.equal(lost,false,'no timer operation on a lost context');if(query)assert.equal(query.generation,generation,'query belongs to this context generation');calls++;};
 const gl={
  QUERY_RESULT_AVAILABLE:1,QUERY_RESULT:2,
  isContextLost:()=>lost,
  getExtension(){check();const extension={GPU_DISJOINT_EXT:3,TIME_ELAPSED_EXT:4};extensions.push(extension);return extension;},
  createQuery(){check();return {generation,id:++next};},
  beginQuery(_target:number,query:{generation:number}){check(query);},
  endQuery(){check();},
  getQueryParameter(query:{generation:number},parameter:number){check(query);return parameter===1?available:5_000_000;},
  getParameter(){check();return false;},
  deleteQuery(query:{generation:number}){check(query);},
 };
 const renderer={getContext:()=>gl,getPixelRatio:()=>1,setPixelRatio(){assert.fail('recovery must not resize from stale timings');}};
 return {renderer,extensions,get calls(){return calls;},lose(){lost=true;},restore(){generation++;lost=false;},complete(){available=true;}};
}

test('graphics recovery abandons active and pending timer queries without touching invalid handles',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'devicePixelRatio');Object.defineProperty(globalThis,'devicePixelRatio',{value:1,configurable:true});
 const gpu=graphics(),monitor=new FrameMonitor(gpu.renderer as any,()=>{});
 try{
  monitor.begin(100);monitor.beforeRender();monitor.end(); // Pending query.
  monitor.begin(116);monitor.beforeRender(); // Second query is still active.
  gpu.lose();monitor.contextLost();const before=gpu.calls;
  monitor.begin(5000);monitor.beforeRender();monitor.end();
  assert.equal(gpu.calls,before,'lost handles must not be polled, ended or deleted');
  assert.equal(monitor.stats.samples,0);assert.equal(monitor.stats.gpuMs,null);
  gpu.restore();monitor.contextRestored();assert.equal(gpu.extensions.length,2,'restoration reacquires the timer extension');
  monitor.begin(6000);monitor.beforeRender();monitor.end();gpu.complete();
  monitor.begin(6016);monitor.beforeRender();monitor.end();
  assert.equal(monitor.stats.gpuMs,5);assert.equal(monitor.stats.maxMs,16,'the lost interval cannot pollute recovered frame pacing');
 }finally{if(descriptor)Object.defineProperty(globalThis,'devicePixelRatio',descriptor);else delete (globalThis as any).devicePixelRatio;}
});

test('loss during a frame is detected before ending its GPU query',()=>{
 const descriptor=Object.getOwnPropertyDescriptor(globalThis,'devicePixelRatio');Object.defineProperty(globalThis,'devicePixelRatio',{value:1,configurable:true});
 const gpu=graphics(),monitor=new FrameMonitor(gpu.renderer as any,()=>{});
 try{
  monitor.begin(100);monitor.beforeRender();gpu.lose();const before=gpu.calls;
  monitor.end();assert.equal(gpu.calls,before);assert.equal(monitor.stats.samples,0);
  gpu.restore();monitor.contextRestored();monitor.begin(200);monitor.beforeRender();monitor.end();
 }finally{if(descriptor)Object.defineProperty(globalThis,'devicePixelRatio',descriptor);else delete (globalThis as any).devicePixelRatio;}
});
