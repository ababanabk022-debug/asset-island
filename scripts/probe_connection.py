"""Read-only probe using the installed add-on's verified JSON protocol."""
import socket, json
from pathlib import Path
commands = [
    {'type': 'get_scene_info', 'params': {}},
    {'type': 'execute_code', 'params': {'code': "import json\nprint(json.dumps({'filepath': bpy.data.filepath, 'is_dirty': bpy.data.is_dirty, 'version': bpy.app.version_string, 'scenes': [s.name for s in bpy.data.scenes], 'objects': [o.name for o in bpy.context.scene.objects]}))"}},
]
results = []
for command in commands:
    with socket.create_connection(('127.0.0.1', 9876), timeout=8) as client:
        client.sendall(json.dumps(command).encode())
        buf = b''
        while True:
            data = client.recv(65536)
            if not data: raise RuntimeError('Connection closed before JSON response')
            buf += data
            try:
                result = json.loads(buf)
                break
            except json.JSONDecodeError: pass
        results.append(result)
print(json.dumps(results, indent=2, ensure_ascii=False))
Path('docs/blender-connection.json').write_text(json.dumps(results, indent=2, ensure_ascii=False), encoding='utf-8')
