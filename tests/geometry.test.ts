import test from 'node:test';
import assert from 'node:assert/strict';
import {GeoFrame} from '../src/geo.ts';
import {readFileSync} from 'node:fs';
test('Tokyo frame preserves metre scale and geodetic coordinates',()=>{const f=new GeoFrame(35.6595,139.7005);f.elevationOffset=36.784;const a=f.toLocal(35.6595,139.7005,15);assert.ok(Math.abs(a.y-51.784)<.0001);const east=f.toLocal(35.6595,139.7005+.00001105,15);assert.ok(Math.abs(a.distanceTo(east)-1)<.01);for(const [lat,lon]of [[35.81,139.098],[33.1111,139.7905],[27.0947,142.1918]]){const p=f.toLocal(lat,lon,45),g=f.toGeo(p.x,p.y,p.z);assert.ok(Math.abs(g.lat-lat)<1e-8);assert.ok(Math.abs(g.lon-lon)<1e-8);assert.ok(Math.abs(g.height-45)<.001);}});
test('atlas includes all 62 municipalities and every central ward',()=>{const j=JSON.parse(readFileSync(new URL('../public/tokyo-tileset.json',import.meta.url),'utf8'));const roots=j.root.children.filter((r:any)=>r._kind==='buildings');assert.equal(roots.length,62);const ids=new Set(roots.map((r:any)=>r.content.uri.match(/\/(13\d{3})_/)[1]));assert.equal(ids.size,62);for(let n=1;n<=23;n++)assert.ok(ids.has(String(13100+n)));});

test('supplemental surfaces use one coherent latest survey per feature type',()=>{
 const j=JSON.parse(readFileSync(new URL('../public/tokyo-tileset.json',import.meta.url),'utf8'));
 const roots=j.root.children.filter((r:any)=>['roads','bridges','paths'].includes(r._kind));
 assert.equal(roots.length,3);
 for(const kind of ['roads','bridges','paths']){
  const selected=roots.filter((r:any)=>r._kind===kind);assert.equal(selected.length,1);
  assert.ok(selected[0].content.uri.endsWith('-latest/tileset.json'));
 }
});

test('authentic street furniture and separately catalogued surveyed trees are included',()=>{
 const j=JSON.parse(readFileSync(new URL('../public/tokyo-tileset.json',import.meta.url),'utf8'));
 assert.ok(j.root.children.some((r:any)=>r._kind==='street-furniture'&&r.content.uri.includes('13-frn-maxlod3-latest')));
 const trees=j.root.children.find((r:any)=>r._subtype==='trees');assert.equal(trees.children.length,13);
 assert.equal(new Set(trees.children.map((r:any)=>r._city)).size,13);
 assert.ok(trees.children.some((r:any)=>r._city==='13113'));
 for(const child of trees.children)assert.ok(child.content.uri.includes('SolitaryVegetationObject'),'PlantCover composite does not substitute for actual surveyed trees.');
});
