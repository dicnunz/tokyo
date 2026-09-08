"""Blender authoring for the measured Tokyo scene and a validated cinematic route.
Run: Blender --background --python scripts/blender_cinema.py -- --input PATH.glb
The atmosphere is authored lighting; all city geometry/textures come from the input.
"""
import argparse, json, math, sys
from pathlib import Path
import bpy
from mathutils import Vector, Matrix

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'public'/'cinema'
OUT.mkdir(parents=True,exist_ok=True)
p=argparse.ArgumentParser();p.add_argument('--input');p.add_argument('--validate-only',action='store_true');p.add_argument('--sky-only',action='store_true');args=p.parse_args(sys.argv[sys.argv.index('--')+1:] if '--'in sys.argv else [])
bpy.ops.wm.read_factory_settings(use_empty=True)
scene=bpy.context.scene
scene.render.engine='CYCLES';scene.cycles.samples=8
scene.render.resolution_x=2048;scene.render.resolution_y=1024;scene.render.resolution_percentage=100
scene.world=bpy.data.worlds.new('Blender authored clear daylight atmosphere');scene.world.use_nodes=True
nodes=scene.world.node_tree.nodes;nodes.clear()
sky=nodes.new('ShaderNodeTexSky');sky.sky_type='MULTIPLE_SCATTERING' if 'MULTIPLE_SCATTERING'in sky.bl_rna.properties['sky_type'].enum_items.keys() else 'NISHITA'
sky.sun_elevation=math.radians(40);sky.sun_rotation=math.radians(135);sky.sun_size=math.radians(.545);sky.sun_intensity=1
sky.air_density=1;sky.ozone_density=1
if hasattr(sky,'aerosol_density'):sky.aerosol_density=.55
else:sky.dust_density=.55
background=nodes.new('ShaderNodeBackground');background.inputs['Strength'].default_value=.3
output=nodes.new('ShaderNodeOutputWorld');scene.world.node_tree.links.new(sky.outputs['Color'],background.inputs['Color']);scene.world.node_tree.links.new(background.outputs[0],output.inputs[0])
bpy.ops.object.camera_add(location=(0,0,0));camera=bpy.context.object;camera.name='Tokyo cinematic camera';scene.camera=camera
camera.data.type='PANO';camera.data.panorama_type='EQUIRECTANGULAR';camera.rotation_euler=(math.pi/2,0,0)
scene.render.image_settings.file_format='HDR';scene.render.filepath=str(OUT/'sky.hdr');scene.view_settings.view_transform='Standard'
sky_settings={'sunElevationDegrees':40,'aerosolDensity':.55,'strength':.3,'lowerHemisphere':'fog-c9e2f2-intensity-.9'}
sky_meta=OUT/'sky-settings.json'
if not (OUT/'sky.hdr').exists() or not sky_meta.exists() or json.loads(sky_meta.read_text())!=sky_settings:
 bpy.ops.render.render(write_still=True)
 sky_meta.write_text(json.dumps(sky_settings,indent=2))
# The sky model's below-ground hemisphere is dark by definition. Extend its
# measured horizon radiance into authored haze so distant streaming edges do
# not reveal a black void when the cinematic camera dives.
import numpy as np
sky_image=bpy.data.images.load(str(OUT/'sky.hdr'),check_existing=False)
w,h=sky_image.size
sky_pixels=np.asarray(sky_image.pixels[:],dtype=np.float32).reshape(h,w,4)
horizon=sky_pixels[h//2,:,:3].copy()
def linear_channel(c):return ((c/255+.055)/1.055)**2.4 if c/255>.04045 else c/255/12.92
neutral=np.array([linear_channel(c)/.9 for c in [201,226,242]],dtype=np.float32)
for row in range(h//2):
 blend=max(0,min(1,(row-(h//2-20))/20));blend=blend*blend*(3-2*blend)
 sky_pixels[row,:,:3]=neutral*(1-blend)+horizon*blend
sky_image.pixels.foreach_set(sky_pixels.ravel())
sky_image.filepath_raw=str(OUT/'sky.hdr');sky_image.file_format='HDR';sky_image.save()
environment=nodes.new('ShaderNodeTexEnvironment');environment.image=sky_image
scene.world.node_tree.links.new(environment.outputs['Color'],background.inputs['Color'])
background.inputs['Strength'].default_value=1
print('SKY_READY',OUT/'sky.hdr',flush=True)
if args.sky_only:sys.exit(0)
if not args.input or not Path(args.input).exists():raise FileNotFoundError('Export the actual measured Tokyo GLB before running city authoring')
bpy.ops.import_scene.gltf(filepath=str(Path(args.input).resolve()))
scene.render.resolution_x=1920;scene.render.resolution_y=1080;scene.render.fps=60;scene.frame_start=1;scene.frame_end=2701
scene.view_settings.view_transform='AgX';camera.data.type='PERSP';camera.data.clip_end=10000;camera.data.clip_start=.15
camera.rotation_mode='QUATERNION'
# Blender glTF axes: Three (east, up, south) -> Blender (east, north, up).
def to_bl(v):return Vector((v[0],-v[2],v[1]))
def to_three(v):return [v.x,v.z,-v.y]
depsgraph=bpy.context.evaluated_depsgraph_get()
def roof(x,z):
 hit,pos,*_=scene.ray_cast(depsgraph,to_bl((x,2000,z)),Vector((0,0,-1)),distance=4000)
 return pos.z if hit else None

def collide(a,b):
 direction=b-a
 if direction.length<1e-6:return False
 return scene.ray_cast(depsgraph,a,direction.normalized(),distance=direction.length)[0]

# Move continuously north through several neighbourhoods. The corridor planner
# routes around tall measured structures at one stable moderate altitude.
mesh_count=sum(ob.type=='MESH' for ob in scene.objects)
vertex_count=sum(len(ob.data.vertices) for ob in scene.objects if ob.type=='MESH')
fps=60;duration=45;count=int(fps*duration)+1
xs=np.arange(-400,301,10,dtype=float);zs=np.arange(500,-501,-10,dtype=float)
roofs=np.full((len(zs),len(xs)),np.nan)
for j,z in enumerate(zs):
 for k,x in enumerate(xs):
  value=roof(float(x),float(z))
  if value is not None:roofs[j,k]=value
known_counts=np.isfinite(roofs).sum(axis=1)
if np.any(known_counts<10):raise RuntimeError('Missing corridor survey geometry: preload x[-400,300],z[-500,500] plus viewing margin')
# Low roof quantiles identify the terrain/street level without inventing DEM.
base_ground=float(np.median([np.nanpercentile(row,10) for row in roofs]))
preferred=np.array([-70-140*math.sin(math.pi*j/(len(zs)-1))-20*j/(len(zs)-1)for j in range(len(zs))])

def plan_at(altitude):
 unsafe=~np.isfinite(roofs)|(roofs>altitude-15)
 blocked=unsafe.copy()
 # 30m dilation makes room for a smooth path, body clearance and tile-grid error.
 for dy in range(-3,4):
  for dx in range(-3,4):
   if dx*dx+dy*dy>9:continue
   ya,yb=max(0,dy),min(len(zs),len(zs)+dy);xa,xb=max(0,dx),min(len(xs),len(xs)+dx)
   blocked[ya:yb,xa:xb]|=unsafe[ya-dy:yb-dy,xa-dx:xb-dx]
 # State carries previous lateral step to penalize angular acceleration.
 steps=[-2,-1,0,1,2];cost=np.full((len(xs),5),np.inf);parents=[]
 for k in range(len(xs)):
  if not blocked[0,k]:cost[k,2]=((xs[k]-preferred[0])/15)**2
 for j in range(1,len(zs)):
  next_cost=np.full_like(cost,np.inf);parent=np.full((len(xs),5),-1,dtype=int)
  for k in range(len(xs)):
   if blocked[j,k]:continue
   for si,step in enumerate(steps):
    old_k=k-step
    if not 0<=old_k<len(xs):continue
    candidates=cost[old_k]+np.array([18*(step-old)**2 for old in steps])
    old_si=int(np.argmin(candidates))
    next_cost[k,si]=candidates[old_si]+step*step*2+((xs[k]-preferred[j])/100)**2
    parent[k,si]=old_si
  cost=next_cost;parents.append(parent)
 cost+=((xs[:,None]-preferred[-1])/15)**2
 if not np.isfinite(cost).any():return None
 k,si=np.unravel_index(np.argmin(cost),cost.shape);path=[float(xs[k])]
 for j in range(len(zs)-2,-1,-1):
  old_si=int(parents[j][k,si]);k-=steps[si];si=old_si;path.append(float(xs[k]))
 return np.array(path[::-1])

positions=None
for clearance in [90,100]:
 altitude=base_ground+clearance
 planned=plan_at(altitude)
 if planned is None:continue
 # Gaussian smoothing removes discrete steering changes. Grid dilation leaves
 # space for this interpolation; actual ray checks below certify the result.
 for sigma in [4,3,2]:
  radius=math.ceil(3*sigma);kernel=np.exp(-.5*(np.arange(-radius,radius+1)/sigma)**2);kernel/=kernel.sum()
  smooth_x=np.convolve(np.pad(planned,radius,mode='edge'),kernel,mode='valid')
  dense_z=np.linspace(zs[0],zs[-1],4001)
  parameter=np.linspace(0,len(zs)-1,len(dense_z));segment=np.minimum(parameter.astype(int),len(zs)-2);fraction=parameter-segment
  tangents=np.gradient(smooth_x)
  f=fraction;dense_x=(2*f**3-3*f*f+1)*smooth_x[segment]+(f**3-2*f*f+f)*tangents[segment]+(-2*f**3+3*f*f)*smooth_x[segment+1]+(f**3-f*f)*tangents[segment+1]
  distances=np.concatenate(([0],np.cumsum(np.hypot(np.diff(dense_x),np.diff(dense_z)))))
  progress=np.linspace(0,distances[-1],count)
  candidate=[Vector((float(x),altitude,float(z)))for x,z in zip(np.interp(progress,distances,dense_x),np.interp(progress,distances,dense_z))]
  valid=True
  for i,pos in enumerate(candidate):
   if i%5==0:
    hits=[roof(pos.x+dx,pos.z+dz)for dx,dz in [(0,0),(-6,0),(6,0),(0,-6),(0,6)]]
    if any(h is None or h>altitude-8 for h in hits):valid=False;break
   if i and collide(to_bl(candidate[i-1]),to_bl(pos)):valid=False;break
  if valid:positions=candidate;break
 if positions is not None:break
if positions is None:raise RuntimeError('No gentle fixed-altitude path found within100m of measured ground; expand lateral source coverage')
# A visible editable path is saved in Blender, excluded from rendering.
curve=bpy.data.curves.new('Forward city route','CURVE');curve.dimensions='3D'
spline=curve.splines.new('POLY');spline.points.add(len(positions[::30])-1)
for point,pos in zip(spline.points,positions[::30]):point.co=(*to_bl(pos),1)
route_object=bpy.data.objects.new('Forward city route',curve);scene.collection.objects.link(route_object);route_object.hide_render=True
samples=[];conversion=Matrix(((1,0,0),(0,0,1),(0,-1,0))).to_quaternion()
for i,pos in enumerate(positions):
 t=i/fps
 # Forward look-ahead follows travel direction with stable world-up and
 # fixed depression. It never locks the view onto an individual tower.
 before=positions[max(0,i-180)];after=positions[min(count-1,i+180)]
 forward=Vector((after.x-before.x,0,after.z-before.z)).normalized()
 look=pos+forward*160;look.y=pos.y-math.tan(math.radians(28))*160
 q=(to_bl(look)-to_bl(pos)).to_track_quat('-Z','Y')
 camera.location=to_bl(pos);camera.rotation_quaternion=q
 fov=58
 camera.data.sensor_fit='HORIZONTAL';camera.data.lens=camera.data.sensor_width/(2*math.tan(math.radians(fov)/2)*(16/9));camera.keyframe_insert(data_path='location',frame=i+1);camera.keyframe_insert(data_path='rotation_quaternion',frame=i+1);camera.data.keyframe_insert(data_path='lens',frame=i+1)
 tq=conversion@q
 samples.append({'time':round(t,6),'position':[round(n,5)for n in pos],'quaternion':[round(tq.x,8),round(tq.y,8),round(tq.z,8),round(tq.w,8)],'fov':round(fov,4)})
for i in range(1,count):
 if collide(to_bl(positions[i-1]),to_bl(positions[i])):raise RuntimeError(f'Final camera collision at frame {i}')
speeds=[(positions[i]-positions[i-1]).length*fps for i in range(1,count)]
angular_speeds=[]
for previous,current in zip(samples,samples[1:]):
 a=previous['quaternion'];b=current['quaternion']
 dot=abs(sum(x*y for x,y in zip(a,b)))/math.sqrt(sum(x*x for x in a)*sum(x*x for x in b))
 angular_speeds.append(math.degrees(2*math.acos(min(1,dot)))*fps)
if not all(positions[i].z<positions[i-1].z for i in range(1,count)):raise RuntimeError('Route must keep moving forward')
if max(angular_speeds)>5:raise RuntimeError('Route turns too rapidly for a gentle drone shot')
length=sum((positions[i]-positions[i-1]).length for i in range(1,count))
metadata={'fps':fps,'duration':duration,'coordinateSystem':'three-y-up-metres','authoring':'Blender '+bpy.app.version_string,'sourceGeometry':Path(args.input).name,'pathLengthMeters':round(length,2),'collisionCheckedSegments':count-1,'meshes':mesh_count,'vertices':vertex_count,'routeType':'continuous forward city traverse','speedMetersPerSecond':round(sum(speeds)/len(speeds),3),'maximumAngularDegreesPerSecond':round(max(angular_speeds),3),'forwardProgressVerified':True,'verticalFieldOfViewDegrees':58,'altitudeMeters':round(altitude,3),'measuredGroundReferenceMeters':round(base_ground,3),'heightAboveGroundReferenceMeters':clearance,'verticalSpeedMetersPerSecond':0,'lookDownDegrees':28,'preloadBounds':{'minX':-1000,'maxX':900,'minZ':-1100,'maxZ':1100},'musicSync':{'bpm':142,'dropSeconds':13.521,'phraseSeconds':[13.521,20.282,27.042,33.803,40.563]},'lighting':'Authored clear daylight atmosphere; not a captured weather observation','samples':samples}
if args.validate_only:
 print('VALIDATED_ROUTE',json.dumps({k:v for k,v in metadata.items()if k!='samples'}),flush=True)
 sys.exit(0)
(OUT/'camera.json').write_text(json.dumps(metadata,separators=(',',':')))
scene.frame_set(1)
scene['source_geometry']=str(Path(args.input).resolve())
scene['camera_coordinate_system']='Three.js x east, y up, z south, metres'
scene['atmosphere']='Blender authored multiple-scattering daylight sky, not observed weather'
scene['collision_checked_segments']=count-1
for screen in bpy.data.screens:
 for area in screen.areas:
  if area.type=='VIEW_3D':
   area.spaces.active.region_3d.view_perspective='CAMERA'
   area.spaces.active.shading.type='MATERIAL'
   area.spaces.active.shading.use_scene_world=True
for ob in scene.objects:
 if ob.type=='MESH':ob.select_set(False)
camera.select_set(True);bpy.context.view_layer.objects.active=camera
bpy.ops.file.pack_all()
bpy.context.preferences.filepaths.save_version=0
blend=ROOT.parent/'tokyo-cinema.blend';bpy.ops.wm.save_as_mainfile(filepath=str(blend))
print('CINEMA_READY',json.dumps({k:v for k,v in metadata.items()if k!='samples'}),flush=True)
