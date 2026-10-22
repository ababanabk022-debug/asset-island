"""Original worn sandstone, calibrated to the existing monetary volume.
Run only in an isolated background Blender; never changes an open user scene.
"""
import bpy, bmesh, math, json, hashlib
from pathlib import Path

assert bpy.app.background
root = Path(__file__).resolve().parents[1]
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
bpy.ops.import_scene.gltf(filepath=str(root / 'assets/source/sandstone-stage-a.glb'))
source = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
mat = source.data.materials[0].copy()

def volume(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.transform(obj.matrix_world)
    value = abs(bm.calc_volume(signed=True))
    bm.free()
    return value

# Gold stays untouched; calibrate against its documented final exported volume.
reserve_path = root / 'assets/manifests/reserve.json'
reserve = json.loads(reserve_path.read_text(encoding='utf8'))
target = reserve['goldVolume'] / 10
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)

bpy.ops.mesh.primitive_cube_add(size=1)
stone = bpy.context.object
stone.name = 'Worn_Sandstone_Reserve_100'
stone.dimensions = (.82, .74, .7)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
mod = stone.modifiers.new('Deep weathered corners', 'BEVEL')
mod.width = .14
mod.segments = 2
bpy.ops.object.modifier_apply(modifier=mod.name)
for v in stone.data.vertices:
    x, y, z = v.co
    # Broad non-identical planes; the flatter base still rests convincingly.
    v.co.x += .045 * math.sin(y * 5 + z * 4) + .025 * math.cos(z * 8 - y * 3)
    v.co.y += .048 * math.sin(x * 5 - z * 4) - .025 * z
    v.co.z += .035 * math.sin(x * 6 + y * 3)
    if z > .20:
        v.co.z += .025 * math.sin(x * 4 - y * 5)
mod = stone.modifiers.new('Export topology', 'TRIANGULATE')
bpy.ops.object.modifier_apply(modifier=mod.name)
bpy.context.view_layer.update()
ratio = (target / volume(stone)) ** (1 / 3)
for v in stone.data.vertices:
    v.co *= ratio
low = min(v.co.z for v in stone.data.vertices)
center_x = (min(v.co.x for v in stone.data.vertices) + max(v.co.x for v in stone.data.vertices)) / 2
center_y = (min(v.co.y for v in stone.data.vertices) + max(v.co.y for v in stone.data.vertices)) / 2
for v in stone.data.vertices:
    v.co.x -= center_x
    v.co.y -= center_y
    v.co.z -= low
stone.data.materials.append(mat)
mat.name = 'Original layered coastal sandstone'
bsdf = next(n for n in mat.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
bsdf.inputs['Roughness'].default_value = .9
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.uv.smart_project(island_margin=.025)
bpy.ops.object.mode_set(mode='OBJECT')
stone.data.update()
bpy.context.view_layer.update()
assert abs(volume(stone) / target - 1) < 1e-6
bpy.ops.wm.save_as_mainfile(filepath=str(root / 'assets/source/sandstone-coastal.blend'))
path = root / 'assets/runtime/sandstone.glb'
bpy.ops.export_scene.gltf(filepath=str(path), export_format='GLB', use_selection=True,
                          export_yup=True, export_animations=False)
points = [stone.matrix_world @ v.co for v in stone.data.vertices]
dims = [max(v[i] for v in points) - min(v[i] for v in points) for i in range(3)]
manifest_path = root / 'assets/manifests/stage-a.json'
manifest = json.loads(manifest_path.read_text(encoding='utf8'))
entry = next(a for a in manifest['assets'] if a['id'] == 'sandstone')
entry.update({
    'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
    'dimensionsGltfXYZ': [dims[0], dims[2], dims[1]], 'dimensionsBlenderXYZ': dims,
    'triangles': sum(len(p.vertices) - 2 for p in stone.data.polygons),
    'materials': [mat.name], 'source': 'assets/source/sandstone-coastal.blend',
    'generator': 'scripts/sculpt-sandstone.py',
})
manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf8')
reserve['sandstoneVolume'] = volume(stone)
reserve['goldToSandstoneVolume'] = reserve['goldVolume'] / volume(stone)
reserve_path.write_text(json.dumps(reserve, indent=2), encoding='utf8')
print('COASTAL_STONE', json.dumps({'volume': volume(stone), 'goldRatio': reserve['goldToSandstoneVolume'], 'dimensions': dims}))

