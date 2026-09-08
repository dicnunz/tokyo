"""Share one full-resolution KTX2 atlas between Blender's two geometry levels.

The OBJ source and its exact original JPEG are supplied through TOKYO_CAPTURE_SOURCES.
This repacks only GLB storage; every remaining geometry bufferView is checked
byte-for-byte. The source JPEG dimensions are never reduced.
"""
from pathlib import Path
import argparse, hashlib, json, math, os, shutil, struct, subprocess, time
from PIL import Image

PROJECT=Path(__file__).resolve().parents[1]
RESEARCH=Path(os.environ['TOKYO_CAPTURE_SOURCES']).expanduser() if os.environ.get('TOKYO_CAPTURE_SOURCES') else None
OUT=PROJECT/'public'/'captures'/'shibuya-2014'
parser=argparse.ArgumentParser();parser.add_argument('--tile',required=True);args=parser.parse_args()
if RESEARCH is None: parser.error('Set TOKYO_CAPTURE_SOURCES to the capture-research directory')
encoder=os.environ.get('TOKYO_TEXTURE_ENCODER') or shutil.which('basisu')
if not encoder: parser.error('Install basisu on PATH or set TOKYO_TEXTURE_ENCODER to its executable')
tile=args.tile;original=RESEARCH/'exterior'/'SizeL'/f'{tile}_0.jpg';ktx=OUT/f'{tile}.ktx2'
Image.MAX_IMAGE_PIXELS=200_000_000
dimensions=Image.open(original).size;started=time.monotonic()
if not ktx.exists():
    temporary=ktx.with_suffix('.partial.ktx2')
    command=[encoder,'-uastc','-uastc_level','0','-ktx2','-mipmap','-mip_filter','box','-ktx2_zstandard_level','1','-max_threads','2','-srgb','-file',str(original),'-output_file',str(temporary)]
    with (RESEARCH/f'{tile}-basis.log').open('w') as log:
        subprocess.run(command,check=True,timeout=300,stdout=log,stderr=subprocess.STDOUT)
    temporary.replace(ktx)
raw=ktx.read_bytes();width,height=struct.unpack_from('<II',raw,20);levels=struct.unpack_from('<I',raw,40)[0]
assert (width,height)==dimensions
assert levels==math.floor(math.log2(max(dimensions)))+1
reports=[]
for suffix in ['', '-low']:
    path=OUT/f'{tile}{suffix}.glb';data=path.read_bytes()
    json_length=struct.unpack_from('<I',data,12)[0];doc=json.loads(data[20:20+json_length]);binary=data[28+json_length:]
    if doc['images'][0].get('uri')==ktx.name:
        reports.append({'file':path.name,'bytes':len(data),'alreadyExternal':True});continue
    assert len(doc['images'])==1 and doc['images'][0]['mimeType']=='image/jpeg'
    image_view=doc['images'][0]['bufferView'];view=doc['bufferViews'][image_view]
    image_bytes=binary[view.get('byteOffset',0):view.get('byteOffset',0)+view['byteLength']]
    assert image_bytes==original.read_bytes(),'Blender changed the original JPEG'
    output=bytearray();views=[];mapping={}
    for old_index,view in enumerate(doc['bufferViews']):
        if old_index==image_view:continue
        output.extend(b'\0'*((-len(output))%4));start=len(output)
        chunk=binary[view.get('byteOffset',0):view.get('byteOffset',0)+view['byteLength']]
        output.extend(chunk);mapping[old_index]=len(views)
        views.append(dict(view,byteOffset=start))
        assert output[start:start+len(chunk)]==chunk
    doc['bufferViews']=views
    for accessor in doc['accessors']:
        if 'bufferView' in accessor:accessor['bufferView']=mapping[accessor['bufferView']]
    doc['images']=[{'uri':ktx.name,'mimeType':'image/ktx2','name':tile}]
    for texture in doc['textures']:
        source=texture.pop('source');texture.setdefault('extensions',{})['KHR_texture_basisu']={'source':source}
    for key in ('extensionsUsed','extensionsRequired'):
        doc.setdefault(key,[])
        if 'KHR_texture_basisu' not in doc[key]:doc[key].append('KHR_texture_basisu')
    doc['buffers'][0]['byteLength']=len(output)
    document=json.dumps(doc,separators=(',',':')).encode();document+=b' '*((-len(document))%4)
    output.extend(b'\0'*((-len(output))%4))
    result=struct.pack('<III',0x46546c67,2,28+len(document)+len(output))+struct.pack('<II',len(document),0x4e4f534a)+document+struct.pack('<II',len(output),0x004e4942)+output
    temporary=path.with_suffix('.partial.glb');temporary.write_bytes(result);temporary.replace(path)
    triangles=sum(doc['accessors'][p['indices']]['count']//3 for m in doc['meshes'] for p in m['primitives'])
    reports.append({'file':path.name,'bytes':len(result),'triangles':triangles,'primitives':sum(len(m['primitives']) for m in doc['meshes'])})
manifest=OUT/'manifest.json';document=json.loads(manifest.read_text())
entry=next(v for v in document['tiles'] if v['id']==tile)
conversion=json.loads((RESEARCH/f'{tile}-conversion.json').read_text())
entry['levels'][1]['triangles']=conversion['lowTriangles'];entry['textureDimensions']=list(dimensions);entry['textureBytes']=len(raw);entry['ready']=True
manifest.write_text(json.dumps(document,indent=2))
report={'tile':tile,'dimensions':list(dimensions),'mips':levels,'ktxBytes':len(raw),'sourceJpegSHA256':hashlib.sha256(original.read_bytes()).hexdigest(),'seconds':time.monotonic()-started,'geometryLevels':reports}
(RESEARCH/f'{tile}-texture.json').write_text(json.dumps(report,indent=2));print(json.dumps(report),flush=True)
