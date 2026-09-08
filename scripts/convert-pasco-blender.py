"""Blender import of the original PASCO OBJ / UV / JPEG and lossless GLB export.

Run Blender --background --python scripts/convert-pasco-blender.py -- --tile STEM
Coordinates prepared by work/capture-research/prepare_coordinates.py use ENU.
Blender's glTF exporter maps them to east/up/south for the Three.js runtime.
"""
import argparse, json, math, sys, time
from pathlib import Path
import bpy
import numpy as np
from mathutils import Vector

PROJECT = Path(__file__).resolve().parents[1]
RESEARCH = PROJECT.parents[1] / 'work' / 'capture-research'
OUT = PROJECT / 'public' / 'captures' / 'shibuya-2014'
parser=argparse.ArgumentParser();parser.add_argument('--tile',required=True);parser.add_argument('--render',action='store_true')
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:])
source = RESEARCH/'exterior'/'SizeL'/f'{args.tile}.obj'
coords=np.load(RESEARCH/'coordinates'/f'{args.tile}.npz')
positions,normals=coords['positions'],np.nan_to_num(coords['normals'])
OUT.mkdir(parents=True,exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
started=time.monotonic()
bpy.ops.wm.obj_import(filepath=str(source),forward_axis='NEGATIVE_Y',up_axis='Z',use_split_objects=False,use_split_groups=False,validate_meshes=False)
meshes=[obj for obj in bpy.context.scene.objects if obj.type=='MESH']
assert len(meshes)==1, f'Unexpected source object count: {len(meshes)}'
obj=meshes[0];mesh=obj.data
# We supply ENU coordinates explicitly, so the OBJ importer's axis transform
# must not be applied a second time.
obj.matrix_world.identity()
assert len(mesh.vertices)==len(positions), f'Blender changed source vertex count {len(mesh.vertices)} vs {len(positions)}'
mesh.vertices.foreach_set('co',positions.ravel())
mesh.normals_split_custom_set_from_vertices(normals)
mesh.update()
texture=bpy.data.images.load(str(source.with_name(source.stem+'_0.jpg')),check_existing=True)
# Partition triangles into ~50m culling cells. All materials share the exact
# original image; the exporter crops vertex streams, preserving every triangle.
indices=np.empty((len(mesh.polygons),3),dtype=np.int32)
mesh.polygons.foreach_get('vertices',indices.ravel())
centroids=positions[indices].mean(axis=1)
keys=np.floor(centroids[:,:2]/50).astype(np.int32)
unique,material_indices=np.unique(keys,axis=0,return_inverse=True)
mesh.materials.clear()
for e,n in unique:
    material=bpy.data.materials.new(f'survey-cell-{e}-{n}');material.use_nodes=True
    nodes=material.node_tree.nodes;nodes.clear()
    image=nodes.new('ShaderNodeTexImage');image.image=texture;image.interpolation='Linear'
    output=nodes.new('ShaderNodeOutputMaterial')
    # Direct colour to Surface is the Blender glTF exporter's recognised
    # shadeless graph, producing KHR_materials_unlit and baseColorTexture.
    material.node_tree.links.new(image.outputs['Color'],output.inputs[0])
    mesh.materials.append(material)
mesh.polygons.foreach_set('material_index',material_indices.astype(np.int32))
obj['source']='PASCO CORPORATION via 3D City Experience Lab.'
obj['surveyDate']='2014-10'
obj['sourceGeometry']='Original measured photogrammetry, all triangles preserved'
obj['sourceHorizontalEPSGInferred']=6677
obj['sourceHorizontalRealizationConfirmed']=False
obj['heightDatum']='orthometric'
obj['localOriginLat']=35.6595;obj['localOriginLon']=139.7005
out=OUT/f'{args.tile}.glb'
bpy.ops.export_scene.gltf(filepath=str(out),export_format='GLB',use_selection=False,export_apply=False,export_extras=True,export_animations=False,export_cameras=False,export_lights=False,export_image_format='AUTO',export_yup=True,export_shared_accessors=False)
report={'tile':args.tile,'sourceVertices':len(positions),'sourceTriangles':len(mesh.polygons),'cullingCells':len(unique),'textureDimensions':list(texture.size),'sourceTextureBytes':source.with_name(source.stem+'_0.jpg').stat().st_size,'glbBytes':out.stat().st_size,'seconds':time.monotonic()-started,'blender':bpy.app.version_string}
(RESEARCH/f'{args.tile}-conversion.json').write_text(json.dumps(report,indent=2));print('PASCO_CONVERTED',json.dumps(report),flush=True)
if args.render:
    scene=bpy.context.scene;scene.render.engine='CYCLES';scene.cycles.samples=4
    scene.render.resolution_x=1600;scene.render.resolution_y=900;scene.render.resolution_percentage=100
    scene.world=bpy.data.worlds.new('Daylight');scene.world.use_nodes=True
    scene.world.node_tree.nodes['Background'].inputs['Color'].default_value=(.48,.68,.9,1)
    scene.view_settings.view_transform='Standard'
    bpy.ops.object.camera_add();camera=bpy.context.object;scene.camera=camera;camera.data.lens=28;camera.data.clip_start=.1
    camera.location=(-35,-10,20)
    # Use the survey surface under the walking position rather than inventing height.
    hit,location,*_=scene.ray_cast(bpy.context.evaluated_depsgraph_get(),Vector((-35,-10,200)),Vector((0,0,-1)))
    if hit:camera.location.z=location.z+1.7
    direction=Vector((-150,120,camera.location.z+4))-camera.location
    camera.rotation_euler=direction.to_track_quat('-Z','Y').to_euler()
    scene.render.filepath=str(RESEARCH/f'{args.tile}-street.png');bpy.ops.render.render(write_still=True)

# Only the optional distant level is simplified. The original high level above
# retains every measured source triangle and every source image pixel.
bpy.context.view_layer.objects.active=obj
obj.select_set(True)
modifier=obj.modifiers.new('Distant survey mesh','DECIMATE');modifier.ratio=.08;modifier.use_collapse_triangulate=True
bpy.ops.object.modifier_apply(modifier=modifier.name)
obj['sourceGeometry']='Distant geometric simplification of the original survey'
low=OUT/f'{args.tile}-low.glb'
bpy.ops.export_scene.gltf(filepath=str(low),export_format='GLB',use_selection=True,export_apply=False,export_extras=True,export_animations=False,export_cameras=False,export_lights=False,export_image_format='AUTO',export_yup=True,export_shared_accessors=False)
report.update({'lowTriangles':len(obj.data.polygons),'lowGlbBytes':low.stat().st_size,'totalSeconds':time.monotonic()-started})
(RESEARCH/f'{args.tile}-conversion.json').write_text(json.dumps(report,indent=2));print('PASCO_LOW_READY',json.dumps(report),flush=True)
