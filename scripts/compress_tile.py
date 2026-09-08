"""Preserve every original binary geometry byte; append full-resolution UASTC images."""
import io,json,math,pathlib,struct,subprocess,sys,tempfile
from PIL import Image

def split(data):
    prefix=b''
    if data[:4]==b'b3dm':
        header=struct.unpack_from('<7I',data);offset=28+sum(header[3:]);prefix=data[:offset];data=data[offset:]
    if data[:4]!=b'glTF':raise ValueError('Only embedded GLB tiles are supported')
    version,total=struct.unpack_from('<II',data,4)
    if version!=2:raise ValueError('Only glTF2 is supported')
    chunks=[];at=12
    while at<total:
        length,kind=struct.unpack_from('<II',data,at);chunks.append((kind,data[at+8:at+8+length]));at+=8+length
    doc=json.loads(next(v for k,v in chunks if k==0x4e4f534a));binary=next(v for k,v in chunks if k==0x004e4942)
    return prefix,doc,binary,chunks

def compress(data,encoder):
    prefix,doc,binary,chunks=split(data)
    images=doc.get('images',[])
    if not images:return data,{'images':0}
    if len(doc.get('buffers',[]))!=1 or doc['buffers'][0].get('uri'):raise ValueError('External buffers require original source')
    def texture_image(index):
        tex=doc['textures'][index]
        return tex.get('extensions',{}).get('EXT_texture_webp',{}).get('source',tex.get('source'))
    linear=set();srgb=set()
    for m in doc.get('materials',[]):
        p=m.get('pbrMetallicRoughness',{})
        for info in [p.get('baseColorTexture'),m.get('emissiveTexture')]:
            if info:srgb.add(texture_image(info['index']))
        for info in [p.get('metallicRoughnessTexture'),m.get('normalTexture'),m.get('occlusionTexture')]:
            if info:linear.add(texture_image(info['index']))
    if linear&srgb:raise ValueError('Shared linear/sRGB image requires original source')
    output=bytearray(binary);dimensions=[]
    with tempfile.TemporaryDirectory(prefix='tokyo-ktx-') as temp:
        for number,image in enumerate(images):
            if image.get('mimeType')=='image/ktx2':continue
            if 'bufferView' not in image:raise ValueError('External image requires original source')
            view=doc['bufferViews'][image['bufferView']]
            encoded=binary[view.get('byteOffset',0):view.get('byteOffset',0)+view['byteLength']]
            source=Image.open(io.BytesIO(encoded));source.load()
            png=pathlib.Path(temp)/f'{number}.png';ktx=pathlib.Path(temp)/f'{number}.ktx2'
            source.convert('RGBA' if 'A' in source.getbands() else 'RGB').save(png,compress_level=1)
            if pathlib.Path(encoder).name=='basisu':
                command=[encoder,'-uastc','-uastc_level','0','-ktx2','-mipmap','-mip_filter','box','-ktx2_zstandard_level','1','-max_threads','2','-linear' if number in linear else '-srgb','-file',str(png),'-output_file',str(ktx)]
            else:
                command=[encoder,'--t2','--encode','uastc','--uastc_quality','0','--zcmp','1','--genmipmap','--filter','box','--threads','2','--assign_oetf','linear' if number in linear else 'srgb','--assign_primaries','bt709','--upper_left_maps_to_s0t0',str(ktx),str(png)]
            subprocess.run(command,check=True,timeout=180,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            packed=ktx.read_bytes();width,height=struct.unpack_from('<II',packed,20);levels=struct.unpack_from('<I',packed,40)[0]
            if (width,height)!=source.size or levels!=math.floor(math.log2(max(source.size)))+1:raise ValueError('Texture dimensions or mip pyramid changed')
            while len(output)%8:output.append(0)
            # The source BIN prefix remains byte-identical. No geometry, Draco,
            # feature table, batch table, accessor, or metadata payload is rebuilt.
            image['bufferView']=len(doc['bufferViews']);doc['bufferViews'].append({'buffer':0,'byteOffset':len(output),'byteLength':len(packed)})
            image['mimeType']='image/ktx2';output.extend(packed);dimensions.append([width,height,levels])
    for tex in doc.get('textures',[]):
        ext=tex.setdefault('extensions',{});source=ext.pop('EXT_texture_webp',{}).get('source',tex.pop('source',None))
        if source is not None:ext['KHR_texture_basisu']={'source':source}
    for name in ['extensionsUsed','extensionsRequired']:
        doc[name]=[v for v in doc.get(name,[]) if v!='EXT_texture_webp']
        if 'KHR_texture_basisu' not in doc[name]:doc[name].append('KHR_texture_basisu')
    doc['buffers'][0]['byteLength']=len(output)
    rawjson=json.dumps(doc,separators=(',',':'),ensure_ascii=False).encode();rawjson+=b' '*((-len(rawjson))%4);output.extend(b'\0'*((-len(output))%4))
    rebuilt=bytearray()
    for kind,payload in chunks:
        value=rawjson if kind==0x4e4f534a else bytes(output) if kind==0x004e4942 else payload
        rebuilt.extend(struct.pack('<II',len(value),kind));rebuilt.extend(value)
    glb=struct.pack('<III',0x46546c67,2,len(rebuilt)+12)+rebuilt
    if prefix:
        prefix=bytearray(prefix);struct.pack_into('<I',prefix,8,len(prefix)+len(glb));glb=prefix+glb
    return bytes(glb),{'images':len(dimensions),'dimensions':dimensions,'sourceBytes':len(data),'outputBytes':len(glb),'geometryPrefixBytes':len(binary)}

if __name__=='__main__':
    source,destination,encoder=sys.argv[1:]
    data,report=compress(pathlib.Path(source).read_bytes(),encoder)
    target=pathlib.Path(destination);temp=target.with_suffix(target.suffix+'.partial');temp.write_bytes(data);temp.replace(target)
    print(json.dumps(report))
