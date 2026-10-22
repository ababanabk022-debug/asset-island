import bpy
from pathlib import Path
root = Path(__file__).resolve().parents[1]
bpy.ops.mesh.primitive_cube_add(size=1, location=(0,0,0.5))
obj = bpy.context.object
obj.name = 'Probe_OneMeter'
bpy.ops.object.select_all(action='DESELECT')
obj.select_set(True)
bpy.ops.wm.save_as_mainfile(filepath=str(root / 'assets/source/export-probe.blend'))
bpy.ops.export_scene.gltf(filepath=str(root / 'assets/runtime/export-probe.glb'), export_format='GLB', use_selection=True)
print('EXPORT_PROBE_OK', list(obj.dimensions))
