"""Refine the original reserve sample, preserving its measured volume."""
import bpy, bmesh, math, random, json, hashlib, shutil
from pathlib import Path
assert bpy.app.background
root = Path(__file__).resolve().parents[1]
original = root/'assets/source/sandstone-stage-a.glb'
if not original.exists(): shutil.copyfile(root/'assets/runtime/sandstone.glb', original)
for obj in list(bpy.data.objects): bpy.data.objects.remove(obj, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=str(original))
stone = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
bpy.context.view_layer.objects.active = stone
bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
def volume():
    bm=bmesh.new(); bm.from_mesh(stone.data); bm.transform(stone.matrix_world)
    v=abs(bm.calc_volume(signed=True)); bm.free(); return v
target=volume()
# Broad, irregular cut faces retain a stable base and small eroded edges.
for vertex in stone.data.vertices:
    x,y,z=vertex.co
    vertex.co.x += .032*math.sin(y*5+z*3)+.018*math.sin(z*11+y*2)
    vertex.co.y += .027*math.sin(x*7-z*4)
    vertex.co.z += .022*math.sin(x*8+y*4)
mod=stone.modifiers.new('Stable export topology','TRIANGULATE')
bpy.ops.object.modifier_apply(modifier=mod.name)
bpy.context.view_layer.update()
ratio=(target/volume())**(1/3)
for vertex in stone.data.vertices: vertex.co*=ratio
low=min(v.co.z for v in stone.data.vertices)
for vertex in stone.data.vertices: vertex.co.z-=low
mat=stone.data.materials[0];mat.use_nodes=True
nodes=mat.node_tree.nodes; bsdf=next(n for n in nodes if n.type=='BSDF_PRINCIPLED')
for link in list(mat.node_tree.links):
    if link.to_node == bsdf: mat.node_tree.links.remove(link)
bsdf.inputs['Roughness'].default_value=.93
image=bpy.data.images.new('Original sandstone mineral grain',width=256,height=256)
rng=random.Random(401); pixels=[]
for y in range(256):
    for x in range(256):
        coarse=.025*math.sin(x*.045+y*.03)+.018*math.sin(x*.09-y*.065)
        grain=rng.gauss(0,.023)
        strata=.012*math.sin(y*.75+math.sin(x*.024)*3)
        n=coarse+grain+strata
        pixels.extend((.62+n,.53+n*.9,.40+n*.7,1))
image.pixels.foreach_set(pixels);image.pack()
texture=nodes.new('ShaderNodeTexImage');texture.image=image
mat.node_tree.links.new(texture.outputs['Color'],bsdf.inputs['Base Color'])
stone.data.update();bpy.context.view_layer.update()
assert abs(volume()/target-1)<1e-5
bpy.ops.wm.save_as_mainfile(filepath=str(root/'assets/source/sandstone-reserve.blend'))
path=root/'assets/runtime/sandstone.glb'
bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,export_yup=True,export_animations=False)
points=[stone.matrix_world @ v.co for v in stone.data.vertices]
dims=[max(v[i] for v in points)-min(v[i] for v in points) for i in range(3)]
manifest_path=root/'assets/manifests/stage-a.json'
manifest=json.loads(manifest_path.read_text(encoding='utf8'))
entry=next(a for a in manifest['assets'] if a['id']=='sandstone')
entry.update({'bytes':path.stat().st_size,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
 'dimensionsGltfXYZ':[dims[0],dims[2],dims[1]],'triangles':sum(len(p.vertices)-2 for p in stone.data.polygons),
 'source':'assets/source/sandstone-reserve.blend','generator':'scripts/refine-sandstone.py'})
manifest_path.write_text(json.dumps(manifest,indent=2),encoding='utf8')
print('SANDSTONE_REFINED_VOLUME',volume(),target)
