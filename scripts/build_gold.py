"""Add a volume-calibrated original gold nugget; isolated Blender process only."""
import bpy, bmesh, math, json, hashlib
from pathlib import Path
from mathutils import Vector
assert bpy.app.background
root = Path(__file__).resolve().parents[1]
for obj in list(bpy.data.objects): bpy.data.objects.remove(obj, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=str(root/'assets/runtime/sandstone.glb'))
def volume(obj):
    bm=bmesh.new(); bm.from_mesh(obj.data); bm.transform(obj.matrix_world)
    result=abs(bm.calc_volume(signed=True)); bm.free(); return result
stone_volume=sum(volume(o) for o in bpy.context.scene.objects if o.type=='MESH')
for obj in list(bpy.data.objects): bpy.data.objects.remove(obj, do_unlink=True)
bpy.ops.mesh.primitive_cube_add(size=1, location=(0,0,0))
gold=bpy.context.object; gold.name='Gold_Reserve_1000'
gold.dimensions=(1.1,.91,.85)
bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
mod=gold.modifiers.new('Broad crystal facets','BEVEL');mod.width=.23;mod.segments=1
bpy.ops.object.modifier_apply(modifier=mod.name)
for v in gold.data.vertices:
    v.co.x += .07*math.sin(v.co.y*8+v.co.z*3)
    v.co.y += .06*math.cos(v.co.x*8-v.co.z*5)
    v.co.z += .045*math.sin(v.co.x*7+v.co.y*5)
bpy.context.view_layer.update()
ratio=(stone_volume*10/volume(gold))**(1/3)
for v in gold.data.vertices:v.co*=ratio
low=min(v.co.z for v in gold.data.vertices)
for v in gold.data.vertices:v.co.z-=low
for name,color,rough,metal in [
    ('Warm gold',(0.73,.43,.065),.32,.72),
    ('Champagne facet',(.95,.71,.24),.27,.65),
    ('Deep gold facet',(.46,.25,.038),.4,.6)]:
    mat=bpy.data.materials.new(name);mat.use_nodes=True;mat.diffuse_color=(*color,1)
    bsdf=next(n for n in mat.node_tree.nodes if n.type=='BSDF_PRINCIPLED');bsdf.inputs['Base Color'].default_value=(*color,1)
    bsdf.inputs['Roughness'].default_value=rough;bsdf.inputs['Metallic'].default_value=metal
    gold.data.materials.append(mat)
gold.data.update()
for face in gold.data.polygons:
    face.material_index=1 if abs(face.normal.z)>.4 and abs(face.normal.z)<.95 else (2 if face.normal.y>.5 else 0)
mod=gold.modifiers.new('Fine edge glints','BEVEL');mod.width=.012;mod.segments=2
bpy.ops.object.modifier_apply(modifier=mod.name)
bpy.context.view_layer.update()
# Match glTF's final topology before measuring: mildly non-planar faces can
# otherwise triangulate differently from BMesh's volume calculation.
mod=gold.modifiers.new('Export topology','TRIANGULATE')
bpy.ops.object.modifier_apply(modifier=mod.name)
bpy.context.view_layer.update()
# Recalibrate after edge finishing; the geometry itself carries the 10:1 ratio.
ratio=(stone_volume*10/volume(gold))**(1/3)
for v in gold.data.vertices:v.co*=ratio
gold.data.update();bpy.context.view_layer.update()
measured=volume(gold)
assert abs(measured/stone_volume-10)<1e-5
bpy.ops.wm.save_as_mainfile(filepath=str(root/'assets/source/gold-reserve.blend'))
path=root/'assets/runtime/gold.glb'
bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_yup=True,export_animations=False)
points=[v.co for v in gold.data.vertices]
dims=[round(max(v[i] for v in points)-min(v[i] for v in points),5) for i in range(3)]
manifest={'schemaVersion':1,'version':'reserve-v2','source':'assets/source/gold-reserve.blend','generator':'scripts/build_gold.py',
 'units':'metres','runtimeUpAxis':'Y','license':'Original geometry authored for this project.',
 'sandstoneVolume':stone_volume,'goldVolume':measured,'goldToSandstoneVolume':measured/stone_volume,'runtimeScale':.45,
 'assets':[{'id':'gold','file':'gold.glb','bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
 'dimensionsGltfXYZ':[dims[0],dims[2],dims[1]],'triangles':sum(len(p.vertices)-2 for p in gold.data.polygons),
 'materials':[m.name for m in gold.data.materials],'animations':[],'anchor':'bottom center'}]}
(root/'assets/manifests/reserve.json').write_text(json.dumps(manifest,indent=2),encoding='utf8')
print('GOLD_VOLUME_VERIFIED',measured/stone_volume)
