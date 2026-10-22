"""Original Stage A assets. Run only in a separate Blender background process.
All outputs are confined to this project. No external models or textures.
Blender Z-up -> glTF Y-up, one Blender unit = one metre.
"""
import bpy
import math
import random
import json
import hashlib
import sys
from pathlib import Path
from mathutils import Vector

ROOT = Path(__file__).resolve().parents[1]
random.seed(41)
# The caller must explicitly start an isolated background process.
assert bpy.app.background, 'Use an isolated background process; never run in the user scene.'
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj, do_unlink=True)


def material(name, color, roughness=0.75, metallic=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get('Principled BSDF')
    shader.inputs['Base Color'].default_value = (*color, 1)
    shader.inputs['Roughness'].default_value = roughness
    shader.inputs['Metallic'].default_value = metallic
    return mat


sand = material('Warm ivory sand', (0.69, 0.53, 0.32))
sand_side = material('Wet shore sand', (0.38, 0.31, 0.19))
rock_mat = material('Warm weathered limestone', (0.35, 0.34, 0.28))
stone_mat = material('Sandstone sample', (0.59, 0.43, 0.23))
ore_mat = material('Blue grey mineral', (0.17, 0.25, 0.26), 0.73, 0.15)
vein_mat = material('Pale mineral seams', (0.43, 0.58, 0.54), 0.45, 0.2)
wood = material('Honey oak', (0.34, 0.19, 0.08))
wood_light = material('Oak end grain', (0.48, 0.29, 0.12))
wood_dark = material('Dark wood joints', (0.13, 0.073, 0.036))
metal = material('Forged fittings', (0.12, 0.16, 0.16), 0.55, 0.55)
roof = material('Muted sea green roof', (0.12, 0.27, 0.25))
linen = material('Warm linen canopy', (0.83, 0.74, 0.54))
green = [material('Palm leaf %d' % i, c) for i, c in enumerate([
    (0.12, 0.26, 0.065), (0.22, 0.36, 0.08), (0.31, 0.43, 0.12)])]


def mesh_obj(name, verts, faces, mat):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def bevel(obj, width=0.04, segments=3):
    bpy.context.view_layer.objects.active = obj
    mod = obj.modifiers.new('Soft worn edges', 'BEVEL')
    mod.width, mod.segments = width, segments
    bpy.ops.object.modifier_apply(modifier=mod.name)
    mod = obj.modifiers.new('Weighted corner normals', 'WEIGHTED_NORMAL')
    mod.keep_sharp = True
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


def box(name, loc, scale, mat, rounding=0.035):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat)
    if rounding:
        bevel(obj, rounding, 3)
    return obj


def rod(name, a, b, radius, mat, vertices=12, radius2=None):
    a, b = Vector(a), Vector(b)
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius,
        radius2=radius if radius2 is None else radius2, depth=(b-a).length, location=(a+b)/2)
    obj = bpy.context.object
    obj.name = name
    obj.rotation_euler = (b-a).to_track_quat('Z', 'Y').to_euler()
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def rock(name, loc, scale, mat, seed):
    rng = random.Random(seed)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1, location=loc)
    obj = bpy.context.object
    obj.name = name
    for vertex in obj.data.vertices:
        v = vertex.co
        perturb = 1 + .075*math.sin(v.x*9+seed)*math.cos(v.y*7) + rng.uniform(-.025,.025)
        v.x *= scale[0]*perturb
        v.y *= scale[1]*perturb
        v.z *= scale[2]*perturb
    obj.data.materials.append(mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def add_surface_texture(mat, kind):
    """Small authored bitmap PBR base color; packed and exported, no lost procedural nodes."""
    size = 128
    img = bpy.data.images.new('Original ' + kind + ' grain', width=size, height=size)
    base = mat.diffuse_color[:3]
    rng = random.Random(72)
    pixels = []
    for y in range(size):
        for x in range(size):
            if kind == 'wood':
                n = .025*math.sin(x*1.8 + .4*math.sin(y*.07)) + .012*math.sin(x*3.7+y*.015)
            elif kind in ['sand', 'limestone']:
                n = .025*math.sin(x*.17)*math.cos(y*.13) + .012*math.sin(x*.4+y*.35)
            else:
                n = .06*math.sin(x*.17)*math.cos(y*.13) + .045*math.sin(x*.4+y*.35)
            n += rng.uniform(-.025,.025)
            # Image data is sRGB; convert the intended linear palette to sRGB first.
            pixels.extend([max(0,min(1,1.055*max(0,c+n)**(1/2.4)-.055)) for c in base] + [1])
    img.pixels[:] = pixels
    img.filepath_raw = str(ROOT / 'assets/source' / (kind + '-grain.png'))
    img.file_format = 'PNG'
    img.save()
    img.pack()
    nodes = mat.node_tree.nodes
    tex = nodes.new('ShaderNodeTexImage')
    tex.image = img
    mat.node_tree.links.new(tex.outputs['Color'], nodes.get('Principled BSDF').inputs['Base Color'])


add_surface_texture(wood, 'wood')
add_surface_texture(stone_mat, 'sandstone')
add_surface_texture(sand, 'sand')
add_surface_texture(rock_mat, 'limestone')

# A closed, gently irregular island with an open flat reserve terrace.
N = 112
rings = [(0.0,.57), (.28,.61), (.55,.59), (.77,.52), (.9,.31), (1.0,.04), (1.08,-.27), (1.04,-.62)]
verts, faces = [], []
for radius, z in rings:
    for i in range(N):
        a = i*2*math.pi/N
        shape = 1+.045*math.sin(3*a+.4)+.027*math.cos(5*a)
        # Slight dunes behind the building; reserve stays level.
        height = z + max(0, math.sin(a))*.1*radius + .018*math.sin(7*a)*radius
        verts.append((5.4*radius*shape*math.cos(a), 4.45*radius*shape*math.sin(a), height))
for j in range(len(rings)-1):
    for i in range(N):
        nxt=(i+1)%N
        faces.append((j*N+i,(j+1)*N+i,(j+1)*N+nxt,j*N+nxt))
faces.append(tuple(reversed(range((len(rings)-1)*N,len(rings)*N))))
island = mesh_obj('Island_closed_terrain',verts,faces,sand)
island.data.materials.append(sand_side)
for p in island.data.polygons:
    p.use_smooth=True
    if p.center.z < .1:
        p.material_index=1

# Shore boulders: clear the front reserve and arrival path.
for i in range(22):
    a = .05 + i/21*math.pi*.94
    x,y = math.cos(a)*4.8, math.sin(a)*3.75
    s=random.uniform(.38,.8)
    rock('Shore limestone %02d'%i,(x,y,.21),(s,s*.85,s*.85),rock_mat,i)
for i,(x,y) in enumerate([(-4.5,-1.5),(-4.1,-2.2),(-3.8,-2.8),(4.9,-.7),(4.6,-1.7)]):
    rock('Beach rock %d'%i,(x,y,.14),(.55,.44,.48),rock_mat,i+60)
for i in range(14):
    a=random.uniform(0,2*math.pi)
    rock('Submerged pebble %d'%i,(6*math.cos(a),5.1*math.sin(a),-.35),(.27,.24,.21),rock_mat,i+90)

# One modest, complete cabin; every side has walls and roof geometry.
cx,cy=-1.85,1.48
box('Cabin foundation',(cx,cy,.7),(2.5,1.95,.26),rock_mat)
box('Cabin dark backing',(cx,cy,1.55),(2.2,1.65,1.55),wood_dark)
mesh_obj('Solid cabin gable',[(cx+x,cy+y,z) for y in [-.83,.83] for x,z in [(-1.1,2.3),(1.1,2.3),(0,2.96)]],
    [(0,1,2),(5,4,3),(0,3,4,1),(1,4,5,2),(2,5,3,0)],wood)
for i in range(12):
    x=cx-1.06+i*.194
    for y in [cy-.85,cy+.85]:
        box('Vertical cabin siding',(x,y,1.57),(.184,.085,1.57),wood if i%3 else wood_light,.014)
for i in range(9):
    y=cy-.78+i*.195
    for x in [cx-1.13,cx+1.13]:
        box('Side cabin siding',(x,y,1.57),(.085,.184,1.57),wood,.014)
for x in [cx-1.14,cx+1.14]:
    for y in [cy-.86,cy+.86]:
        box('Cabin corner post',(x,y,1.6),(.13,.13,1.8),wood_light)
box('Closed cabin door',(cx+.35,cy-.92,1.4),(.63,.07,1.24),roof)
rod('Door handle',(cx+.58,cy-.98,1.4),(cx+.58,cy-.98,1.51),.025,metal)
box('Window recess',(cx-.61,cy-.92,1.7),(.6,.07,.58),wood_dark)
for x in [cx-.91,cx-.61,cx-.31]:
    box('Window frame',(x,cy-.97,1.7),(.045,.06,.64),wood_light,.012)
for z in [1.4,1.7,2.0]:
    box('Window frame',(cx-.61,cy-.97,z),(.65,.06,.045),wood_light,.012)
for side in [-1,1]:
    for j in range(11):
        y=cy-1.02+j*.205
        panel=box('Standing seam roof',(cx+side*.67,y,2.65),(1.57,.198,.09),roof,.022)
        panel.rotation_euler[1]=side*.48
rod('Roof ridge',(cx,cy-1.13,2.99),(cx,cy+1.13,2.99),.065,wood_dark)
# Canvas awning and deck.
box('Porch deck',(cx,cy-1.36,.78),(2.6,1.05,.14),wood)
for x in [cx-1.19,cx+1.19]:
    rod('Awning support',(x,cy-1.82,.72),(x,cy-1.82,2.13),.052,wood_light)
awning=box('Canvas awning',(cx,cy-1.4,2.22),(2.65,1.2,.055),linen,.04)
awning.rotation_euler[0]=.15
for i in range(14):
    rock('Canvas scallop',(cx-1.24+i*.19,cy-1.99,2.1),(.105,.034,.085),linen,210+i)

# Dock, posts and sagging ropes. Front is negative Blender Y.
for i in range(19):
    box('Dock plank %02d'%i,(3.05,-3.1-i*.185,.48),(1.42,.174,.14),wood if i%4 else wood_light,.025)
for x in [2.39,3.71]:
    box('Dock stringer',(x,-4.77,.32),(.13,3.65,.18),wood_dark)
    for y in [-3.6,-4.9,-6.22]:
        rod('Dock piling',(x,y,-.65),(x,y,.96),.09,wood)
        rod('Piling cap',(x,y,.96),(x,y,1.02),.115,wood_light)
    for y in [-3.6,-4.9]:
        for k in range(10):
            t=k/10; u=(k+1)/10
            rod('Rope rail',(x,y-1.3*t,.88-.19*math.sin(t*math.pi)),
                (x,y-1.3*u,.88-.19*math.sin(u*math.pi)),.016,linen,6)


def palm(x,y,h,seed):
    rng=random.Random(seed)
    start=Vector((x,y,.5))
    bend=rng.uniform(-.5,.5)
    for j in range(13):
        t=j/13; u=(j+1)/13
        a=start+Vector((bend*t*t,0,h*t))
        b=start+Vector((bend*u*u,0,h*u))
        rod('Palm trunk ring',a,b,.14-.06*t,wood_light if j%3 else wood,10,radius2=.135-.06*u)
    top=start+Vector((bend,0,h))
    for j in range(9):
        a=j*2*math.pi/9+rng.uniform(-.16,.16)
        length=rng.uniform(1.35,1.9)
        direction=Vector((math.cos(a),math.sin(a),0))
        side=Vector((-math.sin(a),math.cos(a),0))
        leaf_verts=[]
        for k in range(15):
            t=k/14
            p=top+direction*length*t+Vector((0,0,.64*math.sin(t*math.pi)-.4*t))
            width=.24*math.sin(math.pi*t)**.65
            leaf_verts += [tuple(p-side*width),tuple(p+Vector((0,0,.055*math.sin(math.pi*t)))),tuple(p+side*width)]
        leaf_faces=[]
        for k in range(14):
            for col in range(2):
                leaf_faces.append((k*3+col,(k+1)*3+col,(k+1)*3+col+1,k*3+col+1))
        leaf=mesh_obj('Sculpted palm frond',leaf_verts,leaf_faces,green[j%3])
        # Solid leaf edges make the silhouette readable from below.
        bpy.context.view_layer.objects.active=leaf
        mod=leaf.modifiers.new('Leaf thickness','SOLIDIFY'); mod.thickness=.009
        bpy.ops.object.modifier_apply(modifier=mod.name)
        for p in leaf.data.polygons:p.use_smooth=True
        for k in range(1,10):
            t=k/11
            p=top+direction*length*t+Vector((0,0,.64*math.sin(t*math.pi)-.4*t+.015))
            for sign in [-1,1]:
                q=p+side*sign*.17*math.sin(math.pi*t)+direction*.07-Vector((0,0,.025))
                rod('Palm leaf vein',p,q,.005,green[(j+1)%3],5)


palm(-3.7,.1,3.7,22)
palm(.65,3.0,3.8,36)
palm(-3.0,2.95,3.1,51)
# Low vegetation arranged around the rocky border, away from reserve.
for i in range(24):
    a=random.uniform(.05,math.pi*1.04)
    x,y=4.1*math.cos(a),3.3*math.sin(a)
    for j in range(4):
        theta=j*1.6+i
        obj=rock('Coastal broadleaf',(x+.12*math.cos(theta),y+.12*math.sin(theta),.65),(.13,.33,.095),green[i%3],300+i*5+j)
        obj.rotation_euler=(random.uniform(.2,.8),.2,theta)
for i in range(35):
    a=random.uniform(0,2*math.pi)
    x,y=4.5*math.cos(a),3.65*math.sin(a)
    rock('Small beach pebble',(x,y,.28),(.07,.06,.045),stone_mat,i+500)


def unwrap(objects):
    for obj in objects:
        if obj.type != 'MESH':continue
        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active=obj
        if not obj.data.uv_layers:
            bpy.ops.object.mode_set(mode='EDIT')
            bpy.ops.mesh.select_all(action='SELECT')
            bpy.ops.uv.smart_project(island_margin=.02)
            bpy.ops.object.mode_set(mode='OBJECT')


def merge_by_material(objects):
    """Static environment batches: retain all volume, reduce browser draw calls."""
    groups={}
    for obj in objects:
        if obj.type=='MESH':
            key=tuple(m.name for m in obj.data.materials)
            groups.setdefault(key,[]).append(obj)
    output=[]
    for key, group in groups.items():
        bpy.ops.object.select_all(action='DESELECT')
        for obj in group:obj.select_set(True)
        bpy.context.view_layer.objects.active=group[0]
        bpy.ops.object.join()
        group[0].name='Environment_'+'_'.join(key)
        output.append(group[0])
    return output


records=[]
def export(name, objects, anchor='bottom center'):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:obj.select_set(True)
    bpy.context.view_layer.update()
    points=[obj.matrix_world@v.co for obj in objects if obj.type=='MESH' for v in obj.data.vertices]
    low=[min(v[i] for v in points) for i in range(3)]
    high=[max(v[i] for v in points) for i in range(3)]
    dims=[round(high[i]-low[i],4) for i in range(3)]
    triangles=sum(sum(len(p.vertices)-2 for p in obj.data.polygons) for obj in objects if obj.type=='MESH')
    path=ROOT/'assets/runtime'/(name+'.glb')
    bpy.ops.export_scene.gltf(filepath=str(path),export_format='GLB',use_selection=True,
        export_yup=True,export_animations=False,export_extras=True)
    records.append({'id':name,'file':name+'.glb','bytes':path.stat().st_size,
        'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'triangles':triangles,
        'dimensionsBlenderXYZ':dims,'dimensionsGltfXYZ':[dims[0],dims[2],dims[1]],
        'materials':sorted(set(m.name for o in objects if o.type=='MESH' for m in o.data.materials)),
        'anchor':anchor,'animations':[]})


environment=list(bpy.context.scene.objects)
unwrap(environment)
environment=merge_by_material(environment)
export('island-study',environment,'world origin; water surface at glTF Y=0')

# Three candidates only. No production variants or currency mapping yet.
samples=[]
for kind in ['sandstone','ore','crate']:
    previous=set(bpy.context.scene.objects)
    if kind=='sandstone':
        sample=box('Rounded sandstone',(0,0,.34),(.76,.68,.68),stone_mat,.085)
        # Keep the overall block readable, with a few shallow chipped corners.
        for v in sample.data.vertices:
            v.co += Vector((math.sin(v.co.z*21+v.co.y*6),math.cos(v.co.x*17),math.sin(v.co.y*19)))*.008
    elif kind=='ore':
        sample=rock('Mineral block',(0,0,.35),(.42,.38,.35),ore_mat,87)
        for i in range(5):
            obj=box('Mineral seam',(-.24+i*.12,-.325,.36+.055*math.sin(i)),(.034,.025,.34),vein_mat,.008)
            obj.rotation_euler[1]=.38
    else:
        box('Crate inner body',(0,0,.35),(.7,.66,.7),wood_dark,.025)
        for i in range(5):
            v=-.28+i*.14
            for side in [-1,1]:
                box('Crate face slat',(v,side*.343,.35),(.132,.055,.68),wood,.012)
                box('Crate side slat',(side*.368,v,.35),(.055,.132,.68),wood,.012)
            box('Crate lid',(v,0,.714),(.132,.69,.045),wood,.012)
        for z in [.08,.63]:
            for side in [-1,1]:
                box('Crate binding',(0,side*.38,z),(.8,.045,.1),wood_light,.012)
                box('Crate binding',(side*.405,0,z),(.045,.79,.1),wood_light,.012)
        brace=box('Crate diagonal brace',(0,-.41,.35),(.09,.04,.72),wood_light,.01)
        brace.rotation_euler[1]=-.73
        for x in [-.31,.31]:
            for z in [.08,.63]:
                rod('Crate iron pin',(x,-.409,z),(x,-.417,z),.019,metal,8)
    objs=list(set(bpy.context.scene.objects)-previous)
    unwrap(objs)
    objs=merge_by_material(objs)
    export(kind,objs)
    # Place actual exported objects in the Blender showcase, and add three copies.
    root=bpy.data.objects.new('Candidate_'+kind,None)
    bpy.context.collection.objects.link(root)
    for obj in objs:obj.parent=root
    x={'sandstone':-1.7,'ore':.1,'crate':1.9}[kind]
    root.location=(x,-1.75,.58)
    for dx,dy,dz in [(.79,0,0),(.395,.7,0),(.395,.32,.69)]:
        for obj in objs:
            copy=obj.copy();copy.data=obj.data
            bpy.context.collection.objects.link(copy)
            copy.parent=root
            copy.location=obj.location+Vector((dx,dy,dz))
    samples.append(root)

scene=bpy.context.scene
scene.world.color=(.35,.4,.42)
scene.render.engine='CYCLES'
scene.cycles.samples=24
scene.cycles.use_denoising=True
bpy.ops.object.light_add(type='AREA',location=(-3,-4,10))
key=bpy.context.object;key.name='Preview soft daylight';key.data.energy=1600;key.data.shape='DISK';key.data.size=7
bpy.ops.object.light_add(type='AREA',location=(5,2,7))
fill=bpy.context.object;fill.name='Preview sky fill';fill.data.energy=750;fill.data.size=8
bpy.ops.object.camera_add(location=(10,-16,12))
cam=bpy.context.object;cam.name='Preview camera'
cam.rotation_euler=(Vector((0,-.2,.7))-cam.location).to_track_quat('-Z','Y').to_euler()
cam.data.type='ORTHO';cam.data.ortho_scale=16
scene.camera=cam
scene.render.resolution_x=1000;scene.render.resolution_y=800;scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.render.film_transparent=True
scene.view_settings.view_transform='AgX'
scene.render.filepath=str(ROOT/'docs/blender-stage-a.png')
bpy.ops.wm.save_as_mainfile(filepath=str(ROOT/'assets/source/island-study.blend'))
manifest={'schemaVersion':1,'version':'stage-a-1','generator':'scripts/build_samples.py',
    'source':'assets/source/island-study.blend','blenderVersion':bpy.app.version_string,
    'units':'metres','runtimeUpAxis':'Y','license':'Original procedural assets authored for this project; no third-party assets.',
    'scope':'Art candidates only; not a calibrated monetary volume scale.',
    'assets':records}
(ROOT/'assets/manifests/stage-a.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
if '--render' in sys.argv:
    bpy.ops.render.render(write_still=True)
print('STAGE_A_EXPORT_OK',json.dumps({'files':len(records),'triangles':sum(r['triangles'] for r in records)}))
