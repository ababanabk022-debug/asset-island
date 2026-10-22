"""Rebuild the v0.8 terrain and fixed shore rocks in isolated Blender.

The house and palms are retained from the authored Stage A source. The dock's
connected parts alone shrink around the unchanged shore attachment. No active
Blender session or reserve asset is modified. Runtime axes are X/Y(up)/Z;
Blender uses X/-Z/Y(up).
"""
import bpy
import bmesh
import hashlib
import json
import math
import random
from pathlib import Path
from mathutils import Vector

assert bpy.app.background, "Run only with Blender --background."
ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/source/island-study.blend"
OUTPUT = ROOT / "assets/source/island-terrain-0.8.blend"
RUNTIME = ROOT / "assets/runtime/island-study.glb"
MANIFEST = ROOT / "assets/manifests/stage-a.json"
REPORT = ROOT / "docs/terrain-0.8-validation.json"
TAU = math.pi * 2
FLOOR = -1.55
WATER_RADIUS = 7.4

bpy.ops.wm.open_mainfile(filepath=str(SOURCE))
original = [
    obj for obj in bpy.context.scene.objects
    if obj.type == "MESH" and obj.name.startswith("Environment_") and obj.parent is None
]
assert original, "Original static environment was not found."
for obj in list(bpy.context.scene.objects):
    if obj not in original:
        bpy.data.objects.remove(obj, do_unlink=True)


def fingerprint(obj):
    points = [
        tuple(round(n, 7) for n in (obj.matrix_world @ vertex.co))
        for vertex in obj.data.vertices
    ]
    return hashlib.sha256(json.dumps(points, separators=(",", ":")).encode()).hexdigest()


def dry_geometry_fingerprint(obj):
    """Hash actual authored dry vertices and triangles, excluding wet-only rings."""
    obj.data.calc_loop_triangles()
    points = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
    triangles = [
        [tuple(round(value, 7) for value in points[index]) for index in tri.vertices]
        for tri in obj.data.loop_triangles
        if all(points[index].z >= .115 - .000001 for index in tri.vertices)
    ]
    return hashlib.sha256(json.dumps(triangles, separators=(",", ":")).encode()).hexdigest()


def full_geometry_fingerprint(obj):
    obj.data.calc_loop_triangles()
    points = [
        tuple(round(value, 7) for value in (obj.matrix_world @ vertex.co))
        for vertex in obj.data.vertices
    ]
    triangles = [tuple(tri.vertices) for tri in obj.data.loop_triangles]
    return hashlib.sha256(json.dumps([points, triangles], separators=(",", ":")).encode()).hexdigest()


previous_dry_hash = None
previous_frozen_hashes = {}
frozen_rock_mesh = None
frozen_rock_matrix = None
if OUTPUT.exists():
    frozen_names = [
        "Environment_Warm ivory sand", "Environment_Submerged island strata",
        "Environment_Warm weathered limestone - sculpted coast",
    ]
    with bpy.data.libraries.load(str(OUTPUT), link=False) as (data_from, data_to):
        loaded_names = [name for name in frozen_names if name in data_from.objects]
        data_to.objects = list(loaded_names)
    assert "Environment_Warm ivory sand" in loaded_names
    for name, previous_obj in zip(loaded_names, data_to.objects):
        bpy.context.collection.objects.link(previous_obj)
        bpy.context.view_layer.update()
        previous_frozen_hashes[name] = full_geometry_fingerprint(previous_obj)
        if name == "Environment_Warm ivory sand":
            previous_dry_hash = dry_geometry_fingerprint(previous_obj)
        elif name == "Environment_Warm weathered limestone - sculpted coast":
            # The dock-only revision reuses the accepted authored boulders
            # directly; repeating Boolean cuts can reorder internal triangles.
            frozen_rock_mesh = previous_obj.data.copy()
            # An unlinked library object's matrix_world may still be identity.
            # Its mesh stays local to the first authored rock; retain the newly
            # generated, evaluated join transform when reusing this mesh.
            frozen_rock_matrix = previous_obj.matrix_basis.copy()
        previous_mesh = previous_obj.data
        bpy.data.objects.remove(previous_obj, do_unlink=True)
        if previous_mesh.users == 0:
            bpy.data.meshes.remove(previous_mesh)
    for library in list(bpy.data.libraries):
        if Path(bpy.path.abspath(library.filepath)).resolve() == OUTPUT.resolve():
            bpy.data.libraries.remove(library)


preserved = {}
old_terrain = []
old_rocks = []
for obj in original:
    if "Warm ivory sand" in obj.name:
        old_terrain.append(obj)
    elif "Warm weathered limestone" in obj.name:
        old_rocks.append(obj)
    elif "Sandstone sample" in obj.name:
        # Old decorative pebble necklace. The separate draggable sandstone GLB
        # is deliberately not read or written by this script.
        bpy.data.objects.remove(obj, do_unlink=True)
    else:
        preserved[obj.name] = fingerprint(obj)


DOCK_PIVOT = Vector((3.05, -3.013, .48))
DOCK_SCALE = .82
dock_batches = {
    "Environment_Dark wood joints": 2,
    "Environment_Honey oak": 20,
    "Environment_Oak end grain": 11,
    "Environment_Warm linen canopy": 40,
}
dock_report = {}
non_dock_hashes = {}


def subset_fingerprint(obj, indices):
    points = [
        tuple(round(value, 7) for value in (obj.matrix_world @ obj.data.vertices[index].co))
        for index in indices
    ]
    return hashlib.sha256(json.dumps(points, separators=(",", ":")).encode()).hexdigest()


for name, expected_count in dock_batches.items():
    obj = bpy.data.objects[name]
    vertices = obj.data.vertices
    adjacency = [[] for _ in vertices]
    for edge in obj.data.edges:
        a, b = edge.vertices
        adjacency[a].append(b)
        adjacency[b].append(a)
    seen, components = set(), []
    for vertex in vertices:
        if vertex.index in seen:
            continue
        stack, component = [vertex.index], []
        seen.add(vertex.index)
        while stack:
            index = stack.pop()
            component.append(index)
            for other in adjacency[index]:
                if other not in seen:
                    seen.add(other)
                    stack.append(other)
        points = [obj.matrix_world @ vertices[index].co for index in component]
        low = [min(point[i] for point in points) for i in range(3)]
        high = [max(point[i] for point in points) for i in range(3)]
        if low[0] > 2.2 and high[0] < 3.9 and low[1] > -6.7 and high[1] < -2.9:
            components.append((component, low[2] < -.6))
    assert len(components) == expected_count, "Dock component classification changed: " + name
    dock_indices = {index for component, _ in components for index in component}
    other_indices = [vertex.index for vertex in vertices if vertex.index not in dock_indices]
    before = subset_fingerprint(obj, other_indices)
    inverse = obj.matrix_world.inverted()
    for component, is_piling in components:
        for index in component:
            old = obj.matrix_world @ vertices[index].co
            point = DOCK_PIVOT + (old - DOCK_PIVOT) * DOCK_SCALE
            if is_piling and old.z < -.60:
                point.z = old.z
            vertices[index].co = inverse @ point
    obj.data.update()
    assert subset_fingerprint(obj, other_indices) == before, "House/tree/canopy geometry changed with dock."
    non_dock_hashes[name] = (other_indices, before)
    dock_report[name] = {"components": len(components), "vertices": len(dock_indices)}
    preserved.pop(name)

assert old_terrain and old_rocks
for obj in old_terrain:
    bpy.data.objects.remove(obj, do_unlink=True)


def preserve_cabin_foundation(obj):
    """The old limestone batch also contains the cabin's exact foundation.
    Weld export seams, identify disconnected pieces, retain only that box."""
    mesh = bmesh.new()
    mesh.from_mesh(obj.data)
    bmesh.ops.remove_doubles(mesh, verts=list(mesh.verts), dist=0.000001)
    visited, components = set(), []
    for vertex in mesh.verts:
        if vertex in visited:
            continue
        component, stack = [], [vertex]
        visited.add(vertex)
        while stack:
            v = stack.pop()
            component.append(v)
            for edge in v.link_edges:
                other = edge.other_vert(v)
                if other not in visited:
                    visited.add(other)
                    stack.append(other)
        components.append(component)
    keep = []
    for component in components:
        points = [obj.matrix_world @ v.co for v in component]
        low = [min(p[i] for p in points) for i in range(3)]
        high = [max(p[i] for p in points) for i in range(3)]
        center = [(low[i] + high[i]) / 2 for i in range(3)]
        if abs(center[0] + 1.85) < .01 and abs(center[1] - 1.48) < .01 and abs(center[2] - .7) < .01:
            keep.extend(component)
    assert keep, "Cabin foundation could not be isolated."
    keep = set(keep)
    bmesh.ops.delete(mesh, geom=[v for v in mesh.verts if v not in keep], context="VERTS")
    mesh.to_mesh(obj.data)
    mesh.free()
    obj.data.update()
    obj.name = "Environment_Cabin foundation_Warm weathered limestone"
    return obj


foundations = [preserve_cabin_foundation(obj) for obj in old_rocks]


def smoothstep(t):
    t = max(0., min(1., t))
    return t * t * (3. - 2. * t)


def angle_distance(a, b):
    return math.atan2(math.sin(a - b), math.cos(a - b))


def dry_radius(angle):
    """A star-shaped 0.115-m contour, with an open sand cove for the boat."""
    bay_east = math.exp(-(angle_distance(angle, .22) / .38) ** 2)
    bay_west = math.exp(-(angle_distance(angle, 2.52) / .39) ** 2)
    harbor = math.exp(-(angle_distance(angle, 1.34) / .29) ** 2)
    return .92 * (5.52 + .34 * math.sin(angle - .35)
            + .14 * math.sin(3 * angle + .35) + .09 * math.cos(5 * angle - .4)
            - .38 * bay_east - .30 * bay_west - 1.40 * harbor)


def outer_radius(angle):
    # Exactly matches containerGeometry.waterOutline in the runtime.
    return WATER_RADIUS * (1 + .0032 * math.sin(angle * 5 + .6)
                           + .0018 * math.cos(angle * 9 - .3))


PROFILE = [
    (0., .555), (.28, .565), (.52, .555), (.69, .525),
    (.80, .47), (.88, .375), (.94, .255), (1., .115),
]


def ground_height(x, z):
    r, angle = math.hypot(x, z), math.atan2(z, x)
    dry, outer = dry_radius(angle), outer_radius(angle)
    if r <= dry:
        t = r / dry
        height = .115
        for (a, ha), (b, hb) in zip(PROFILE, PROFILE[1:]):
            if a <= t <= b:
                height = ha + (hb - ha) * smoothstep((t - a) / (b - a))
                break
        # Broad low dunes, no lumpy small-scale physics surface in the courtyard.
        detail = .012 * math.sin(x * .86 + z * .24) * math.cos(z * .74 - x * .18)
        return height + detail * (1 - smoothstep((t - .74) / .24))
    height = .115 + (-.115 - .115) * smoothstep((r - dry) / .34)
    # The existing 2.8-m boat stays moored at (1.25, 5.27). This sand channel
    # starts strictly outside the active contour, so it is a coastal inlet,
    # never a hidden water hole in the playable courtyard.
    harbor = math.exp(-(angle_distance(angle, 1.34) / .23) ** 2)
    channel = smoothstep((r - dry) / .30)
    return height - .12 * harbor * channel


def linear_to_srgb(value):
    return 12.92 * value if value <= .0031308 else 1.055 * value ** (1 / 2.4) - .055


def textured_material(name, base, kind):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = (*base, 1)
    principled = mat.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Roughness"].default_value = .91 if kind == "sand" else .88
    size = 256
    image = bpy.data.images.new("v0.8 original " + kind + " microtexture", width=size, height=size)
    rng = random.Random(804 if kind == "sand" else 809)
    pixels = []
    for y in range(size):
        for x in range(size):
            if kind == "sand":
                grain = rng.uniform(-.022, .022)
                grain += .009 * math.sin(x * .47 + math.sin(y * .13))
                grain += .006 * math.sin(x * .05) * math.cos(y * .07)
            else:
                grain = rng.uniform(-.009, .009)
                grain += .018 * math.sin(y * .09 + math.sin(x * .031) * 1.1)
                grain += .010 * math.sin(y * .43 + math.sin(x * .055) * 1.2)
            pixels.extend([linear_to_srgb(max(.002, min(1., c + grain))) for c in base] + [1.])
    image.pixels.foreach_set(pixels)
    image.pack()
    texture = mat.node_tree.nodes.new("ShaderNodeTexImage")
    texture.image = image
    texture.interpolation = "Linear"
    mat.node_tree.links.new(texture.outputs["Color"], principled.inputs["Base Color"])
    return mat


# Free the previous terrain-only material name so the collider's stable readable
# node/material contract does not acquire an accidental '.001' suffix.
for name in ["Warm ivory sand", "Wet shore sand"]:
    mat = bpy.data.materials.get(name)
    if mat and mat.users == 0:
        bpy.data.materials.remove(mat)
for mat in list(bpy.data.materials):
    if "sculpted coast" in mat.name and mat.users == 0:
        bpy.data.materials.remove(mat)
sand_mat = textured_material("Warm ivory sand - sculpted coast", (.76, .72, .62), "sand")
rock_mat = textured_material("Warm weathered limestone - sculpted coast", (.35, .36, .335), "limestone")
strata_mat = textured_material("Submerged limestone - sculpted coast", (.30, .335, .315), "limestone")

segments = 192
vertices = [(0., 0., ground_height(0., 0.))]
faces = []
ring_count = 26
for ring in range(1, ring_count + 1):
    for i in range(segments):
        angle = i * TAU / segments
        dry, outer = dry_radius(angle), outer_radius(angle)
        if ring <= 24:
            radius = dry * ring / 24
        else:
            radii = [dry + .15, dry + .34]
            radius = radii[ring - 25]
        x, z = math.cos(angle) * radius, math.sin(angle) * radius
        vertices.append((x, -z, ground_height(x, z)))

for i in range(segments):
    faces.append((0, 1 + (i + 1) % segments, 1 + i))
for ring in range(ring_count - 1):
    for i in range(segments):
        a = 1 + ring * segments + i
        b = 1 + ring * segments + (i + 1) % segments
        c, d = a + segments, b + segments
        faces.append((a, b, d, c))

terrain_mesh = bpy.data.meshes.new("Continuous sculpted sand terrain 0.8")
terrain_mesh.from_pydata(vertices, [], faces)
terrain_mesh.materials.append(sand_mat)
terrain_mesh.update()
# Runtime X/Z -> Blender X/-Y reverses planar winding; make the entire top face up.
bm = bmesh.new()
bm.from_mesh(terrain_mesh)
bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
if sum(face.normal.z for face in bm.faces) < 0:
    bmesh.ops.reverse_faces(bm, faces=list(bm.faces))
bm.to_mesh(terrain_mesh)
bm.free()
for polygon in terrain_mesh.polygons:
    polygon.use_smooth = True
uv = terrain_mesh.uv_layers.new(name="Sand world coordinates")
for polygon in terrain_mesh.polygons:
    for loop in polygon.loop_indices:
        p = terrain_mesh.vertices[terrain_mesh.loops[loop].vertex_index].co
        uv.data[loop].uv = (p.x / 5 + .5, p.y / 5 + .5)
terrain = bpy.data.objects.new("Environment_Warm ivory sand", terrain_mesh)
bpy.context.collection.objects.link(terrain)
terrain["terrainVersion"] = "0.8"
terrain["supportContourY"] = .115
terrain["waterFloorY"] = FLOOR
terrain["continuousSandShelf"] = True
terrain["sandShelfWidth"] = .34
dry_hash = dry_geometry_fingerprint(terrain)
# The user's latest revision explicitly reduces the playable land by eight
# percent; this intentionally supersedes the earlier dry-geometry freeze.

# A separate underwater land mass narrows down toward its submerged base. The
# top ring exactly shares the sand beach edge; the deep water outside it remains
# clear down to the separately rendered white seabed.
strata_vertices = []
for level in range(5):
    for i in range(segments):
        angle = i * TAU / segments
        upper = dry_radius(angle) + .34
        if level == 0:
            radius = upper
            y = ground_height(math.cos(angle) * radius, math.sin(angle) * radius)
        elif level == 1:
            radius = upper * (.94 + .008 * math.sin(angle * 5 + .6))
            y = -.36 + .018 * math.sin(angle * 3 + .7)
        elif level == 2:
            radius = upper * (.87 + .017 * math.sin(angle * 4 - .4))
            y = -.76 + .025 * math.sin(angle * 4)
        elif level == 3:
            radius = upper * (.80 + .015 * math.sin(angle * 6 + .4))
            y = -1.14 + .020 * math.sin(angle * 5 + .8)
        else:
            radius = upper * (.74 + .008 * math.sin(angle * 3))
            y = -1.43
        strata_vertices.append((math.cos(angle) * radius, -math.sin(angle) * radius, y))
strata_faces = []
for level in range(4):
    for i in range(segments):
        a = level * segments + i
        b = level * segments + (i + 1) % segments
        strata_faces.append((a, a + segments, b + segments, b))
strata_faces.append(tuple(range(4 * segments, 5 * segments)))
strata_mesh = bpy.data.meshes.new("Tapered submerged land mass 0.8")
strata_mesh.from_pydata(strata_vertices, [], strata_faces)
strata_mesh.materials.append(strata_mat)
strata_mesh.update()
bm = bmesh.new()
bm.from_mesh(strata_mesh)
bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
bm.to_mesh(strata_mesh)
bm.free()
for polygon in strata_mesh.polygons:
    polygon.use_smooth = len(polygon.vertices) == 4
strata_uv = strata_mesh.uv_layers.new(name="Submerged stratum coordinates")
for polygon in strata_mesh.polygons:
    for loop in polygon.loop_indices:
        p = strata_mesh.vertices[strata_mesh.loops[loop].vertex_index].co
        strata_uv.data[loop].uv = (math.atan2(p.y, p.x) / TAU * 3, p.z * 1.3)
strata = bpy.data.objects.new("Environment_Submerged island strata", strata_mesh)
bpy.context.collection.objects.link(strata)
strata["waterOnlyGeometry"] = True
frozen_hashes = {
    terrain.name: full_geometry_fingerprint(terrain),
    strata.name: full_geometry_fingerprint(strata),
}
assert (not previous_frozen_hashes
        or frozen_hashes[terrain.name] == previous_frozen_hashes[terrain.name]), \
    "Terrain or shallow beach changed during the rocks-only revision."


def sculpted_rock(name, x, z, width, depth, height, angle, seed, crack=False):
    rng = random.Random(seed)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius=1)
    obj = bpy.context.object
    obj.name = name
    phase = rng.uniform(0, TAU)
    shear_x, shear_y = rng.uniform(-.19, .19), rng.uniform(-.16, .16)
    # Long wavelength deformation preserves a calm, worn silhouette. There
    # are no radial profile rings and no repeating horizontal layer seams.
    for vertex in obj.data.vertices:
        p = vertex.co.copy()
        bulge = (1 + .13 * math.sin(p.x * 2.7 + p.y * 1.9 + phase)
                 + .065 * math.cos(p.z * 3.2 - p.y * 2.3 + phase * .7))
        vertex.co = Vector((
            p.x * bulge + shear_x * p.z + .06 * p.y * p.y,
            p.y * bulge + shear_y * p.z,
            p.z * bulge + .12 * p.x - .08 * p.y,
        ))
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    # A slanted pressure fracture on the crown and a second irregular flank
    # cut give the rounded body a few broad, natural faces. Plane directions
    # vary per rock; none is parallel to the ground or the other cut.
    plane_specs = [
        (Vector((rng.uniform(-.60, .60), rng.uniform(-.55, .55), 1)).normalized(),
         rng.uniform(.68, .84)),
        (Vector((math.cos(phase), math.sin(phase), rng.uniform(-.28, .45))).normalized(),
         rng.uniform(.72, .90)),
    ]
    for normal, distance in plane_specs:
        cut = bmesh.ops.bisect_plane(
            bm, geom=list(bm.verts) + list(bm.edges) + list(bm.faces),
            plane_co=normal * distance, plane_no=normal,
            clear_outer=True, clear_inner=False, dist=.000001,
        )
        edges = [edge for edge in cut["geom_cut"]
                 if isinstance(edge, bmesh.types.BMEdge) and edge.is_boundary]
        if edges:
            bmesh.ops.holes_fill(bm, edges=edges, sides=0)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(obj.data)
    bm.free()
    low = [min(vertex.co[i] for vertex in obj.data.vertices) for i in range(3)]
    high = [max(vertex.co[i] for vertex in obj.data.vertices) for i in range(3)]
    for vertex in obj.data.vertices:
        vertex.co.x = (vertex.co.x - (low[0] + high[0]) / 2) / (high[0] - low[0]) * width
        vertex.co.y = (vertex.co.y - (low[1] + high[1]) / 2) / (high[1] - low[1]) * depth
        vertex.co.z = (vertex.co.z - low[2]) / (high[2] - low[2]) * height - height * .13
    if crack and height > .60:
        # One short diagonal fissure opens only on the outward face. It does
        # not cross the entire rock, so the volume still reads as one boulder.
        bpy.ops.mesh.primitive_cube_add(size=1)
        cutter = bpy.context.object
        cutter.dimensions = (width * .52, depth * .19, height * .027)
        cutter.location = (width * .13, -depth * .46, height * rng.uniform(.36, .51))
        cutter.rotation_euler = (.20, rng.uniform(-.45, -.20), rng.uniform(-.25, .25))
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        bpy.context.view_layer.objects.active = obj
        boolean = obj.modifiers.new("One local diagonal pressure fissure", "BOOLEAN")
        boolean.operation = "DIFFERENCE"
        boolean.solver = "EXACT"
        boolean.object = cutter
        bpy.ops.object.modifier_apply(modifier=boolean.name)
        bpy.data.objects.remove(cutter, do_unlink=True)
    obj.data.materials.clear()
    obj.data.materials.append(rock_mat)
    for polygon in obj.data.polygons:
        polygon.material_index = 0
    obj.rotation_euler = (rng.uniform(-.25, .25), rng.uniform(-.28, .28), angle + phase * .17)
    # Main groups follow the smaller new land; a few outer toes remain wet.
    x, z = x * .94, z * .94
    obj.location = (x, -z, ground_height(x, z) - .055)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bevel = obj.modifiers.new("Small naturally worn facet edges", "BEVEL")
    bevel.width = min(width, depth, height) * .023
    bevel.segments = 2
    bevel.affect = "EDGES"
    bevel.limit_method = "ANGLE"
    bevel.angle_limit = .46
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    normal = obj.modifiers.new("Weathered broad plane normals", "WEIGHTED_NORMAL")
    normal.keep_sharp = True
    normal.weight = 40
    bpy.ops.object.modifier_apply(modifier=normal.name)
    return obj


# Three uneven outcrops frame a broad foreground sand bay. Several blocks
# overlap/step naturally; there is deliberately no ring of equidistant boulders.
rock_specs = [
    # High east/back group, readable behind the garden and away from the cloud.
    (3.05, -3.15, 1.45, 1.22, 1.52, .22, 810, True),
    (3.85, -2.45, 1.28, 1.15, 1.04, -.18, 811, True),
    (2.13, -3.82, 1.34, 1.13, 1.10, .35, 812, False),
    (3.14, -4.12, 1.26, .92, .76, -.27, 813, False),
    (4.18, -1.68, .95, 1.10, .72, .40, 814, False),
    (2.35, -2.91, .92, .80, .64, -.43, 815, False),
    # Lower west cluster; the leaning palm still rises freely in front.
    (-4.20, -2.14, 1.15, 1.05, 1.08, -.32, 821, True),
    (-4.55, -1.20, .98, 1.07, .76, .23, 822, False),
    (-3.84, -2.95, 1.10, .92, .78, -.13, 823, False),
    (-4.34, -.30, 1.06, .90, .48, .38, 824, False),
    (-3.68, -1.87, .83, .72, .55, -.52, 825, False),
    # A small low shelf on the east flank, with a wide opening to the dock.
    (4.46, .08, .96, 1.10, .70, .18, 831, True),
    (4.63, 1.05, .88, .65, .37, -.36, 832, False),
    (4.00, .66, .74, .54, .25, .42, 833, False),
    # Fractured skirts nest against each cluster's feet, without a pebble ring.
    (3.48, -1.95, .50, .37, .27, -.49, 841, False),
    (4.50, -2.10, .46, .64, .35, .61, 842, False),
    (2.55, -4.24, .61, .42, .31, -.22, 843, False),
    (-4.32, -2.78, .48, .40, .32, .49, 844, False),
    (-4.66, -.68, .41, .59, .25, -.29, 845, False),
    (4.69, .45, .47, .38, .22, -.13, 846, False),
    (4.07, 1.18, .42, .35, .20, .78, 847, False),
]
rocks = [
    sculpted_rock("Sculpted shore limestone %02d" % i, *spec)
    for i, spec in enumerate(rock_specs)
]
for obj in rocks:
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(island_margin=.025)
    bpy.ops.object.mode_set(mode="OBJECT")

bpy.ops.object.select_all(action="DESELECT")
for obj in rocks:
    obj.select_set(True)
bpy.context.view_layer.objects.active = rocks[0]
bpy.ops.object.join()
rocks = [bpy.context.object]
rocks[0].name = "Environment_Warm weathered limestone - sculpted coast"
bpy.context.view_layer.update()
authored_rock_matrix = rocks[0].matrix_world.copy()
if frozen_rock_mesh is not None:
    generated_rock_mesh = rocks[0].data
    rocks[0].data = frozen_rock_mesh
    rocks[0].matrix_world = authored_rock_matrix
    if generated_rock_mesh.users == 0:
        bpy.data.meshes.remove(generated_rock_mesh)
bpy.context.view_layer.update()
frozen_hashes[rocks[0].name] = full_geometry_fingerprint(rocks[0])
print("FROZEN_GEOMETRY_CHECK", json.dumps({
    name: {"old": old, "new": frozen_hashes[name]}
    for name, old in previous_frozen_hashes.items()
}))
assert all(frozen_hashes[name] == old for name, old in previous_frozen_hashes.items()
           if name != rocks[0].name), \
    "Terrain or submerged body changed during the rock transform correction."

# Verify each disconnected boulder in actual evaluated world space. Hashing
# only an unlinked local mesh would miss a lost batch transform.
rock_obj = rocks[0]
rock_vertices = rock_obj.data.vertices
rock_adjacency = [[] for _ in rock_vertices]
for edge in rock_obj.data.edges:
    a, b = edge.vertices
    rock_adjacency[a].append(b)
    rock_adjacency[b].append(a)
rock_seen, rock_parts = set(), []
for vertex in rock_vertices:
    if vertex.index in rock_seen:
        continue
    stack, component = [vertex.index], []
    rock_seen.add(vertex.index)
    while stack:
        index = stack.pop()
        component.append(index)
        for other in rock_adjacency[index]:
            if other not in rock_seen:
                rock_seen.add(other)
                stack.append(other)
    points = [rock_obj.matrix_world @ rock_vertices[index].co for index in component]
    runtime_points = [(p.x, p.z, -p.y) for p in points]
    low = [min(p[i] for p in runtime_points) for i in range(3)]
    high = [max(p[i] for p in runtime_points) for i in range(3)]
    center = [(low[i] + high[i]) / 2 for i in range(3)]
    closest = min(range(len(rock_specs)), key=lambda i:
        (center[0] - rock_specs[i][0] * .94) ** 2 + (center[2] - rock_specs[i][1] * .94) ** 2)
    offset = math.hypot(center[0] - rock_specs[closest][0] * .94,
                        center[2] - rock_specs[closest][1] * .94)
    assert offset < .30, "A shore rock moved away from its authored world position."
    group = ("east_back" if closest < 6 or closest in [14, 15, 16]
             else "west_back" if closest < 11 or closest in [17, 18] else "east_flank")
    rock_parts.append({
        "authoredIndex": closest, "group": group,
        "worldCenter": [round(v, 5) for v in center],
        "worldBounds": [[round(v, 5) for v in low], [round(v, 5) for v in high]],
        "centerOffsetFromAuthoredXZ": round(offset, 6),
    })
assert len(rock_parts) == len(rock_specs) == 21, "Rock connected-part count changed."
assert len({part["authoredIndex"] for part in rock_parts}) == 21, "Rock authored position assignment is not one-to-one."
rock_center_radii = [math.hypot(part["worldCenter"][0], part["worldCenter"][2]) for part in rock_parts]
assert min(rock_center_radii) > 3.5, "Fixed shore rocks entered the central courtyard."
assert all(part["worldCenter"][0] > 2.0 for part in rock_parts if part["group"] == "east_back")
assert all(-5.0 < part["worldCenter"][0] < -3.0 for part in rock_parts if part["group"] == "west_back")
rock_placement_summary = {
    "centersBeyondRadius3_5": sum(radius > 3.5 for radius in rock_center_radii),
    "centersInsideRadius2": sum(radius < 2 for radius in rock_center_radii),
    "minimumCenterRadius": min(rock_center_radii),
    "evaluatedWorldMatrixUsed": True,
}
rock_group_bounds = {}
for group in ["east_back", "west_back", "east_flank"]:
    parts = [part for part in rock_parts if part["group"] == group]
    low = [min(part["worldBounds"][0][i] for part in parts) for i in range(3)]
    high = [max(part["worldBounds"][1][i] for part in parts) for i in range(3)]
    rock_group_bounds[group] = {
        "count": len(parts), "worldBounds": [low, high],
        "worldBoundsCenter": [round((low[i] + high[i]) / 2, 5) for i in range(3)],
    }

# Check every retained authored object's vertices in world coordinates. New
# terrain/rocks cannot quietly move or scale an existing house/tree/dock batch.
for name, before in preserved.items():
    obj = bpy.data.objects.get(name)
    assert obj is not None and fingerprint(obj) == before, "Preserved prop changed: " + name
for name, (indices, before) in non_dock_hashes.items():
    assert subset_fingerprint(bpy.data.objects[name], indices) == before, "Non-dock component changed: " + name

environment = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
bpy.ops.object.select_all(action="DESELECT")
for obj in environment:
    obj.select_set(True)
bpy.context.view_layer.update()
points = [obj.matrix_world @ v.co for obj in environment for v in obj.data.vertices]
low = [min(p[i] for p in points) for i in range(3)]
high = [max(p[i] for p in points) for i in range(3)]
dimensions = [round(high[i] - low[i], 6) for i in range(3)]
triangles = sum(len(p.vertices) - 2 for obj in environment for p in obj.data.polygons)
assert triangles < 110000, "Static environment triangle budget exceeded."
terrain_mesh.calc_loop_triangles()
assert all(tri.normal.z > 0 for tri in terrain_mesh.loop_triangles), "Terrain folds or inverted triangles."

bpy.ops.export_scene.gltf(
    filepath=str(RUNTIME), export_format="GLB", use_selection=True,
    export_yup=True, export_animations=False, export_extras=True,
)

# Save an independent, convenient source scene with a camera. Cameras/lights are
# added only after export and are never fed into the runtime.
scene = bpy.context.scene
scene.world.color = (.35, .42, .45)
scene.render.engine = "CYCLES"
scene.cycles.samples = 20
scene.cycles.use_denoising = True
bpy.ops.object.light_add(type="AREA", location=(-3, -4, 10))
bpy.context.object.data.energy = 1500
bpy.context.object.data.size = 7
bpy.ops.object.light_add(type="AREA", location=(5, 3, 7))
bpy.context.object.data.energy = 650
bpy.context.object.data.size = 8
bpy.ops.object.camera_add(location=(11, -17, 13))
camera = bpy.context.object
camera.name = "Terrain 0.8 review camera"
camera.rotation_euler = (Vector((0, 0, .5)) - camera.location).to_track_quat("-Z", "Y").to_euler()
camera.data.type = "ORTHO"
camera.data.ortho_scale = 18
scene.camera = camera
scene.render.resolution_x = 1200
scene.render.resolution_y = 1000
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.view_settings.view_transform = "AgX"
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=str(OUTPUT))

manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
entry = next(asset for asset in manifest["assets"] if asset["id"] == "island-study")
entry.update({
    "bytes": RUNTIME.stat().st_size,
    "sha256": hashlib.sha256(RUNTIME.read_bytes()).hexdigest(),
    "triangles": triangles,
    "dimensionsBlenderXYZ": dimensions,
    "dimensionsGltfXYZ": [dimensions[0], dimensions[2], dimensions[1]],
    "materials": sorted({mat.name for obj in environment for mat in obj.data.materials if mat is not None}),
    "source": "assets/source/island-terrain-0.8.blend",
    "generator": "scripts/remodel-island-terrain.py",
    "terrainVersion": "0.8",
    "anchor": "world origin; glTF Y-up; smaller white sand land, narrow shore, tapered submerged island",
})
MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
report = {
    "source": str(OUTPUT.relative_to(ROOT)),
    "generator": "scripts/remodel-island-terrain.py",
    "blender": bpy.app.version_string,
    "backgroundOnly": True,
    "preservedWorldGeometry": preserved,
    "preservedBatchCount": len(preserved),
    "preservedNonDockGeometryInResizedBatches": {
        name: before for name, (_, before) in non_dock_hashes.items()
    },
    "dockResize": {
        "scale": DOCK_SCALE,
        "pivotWorldXYZ": [3.05, .48, 3.013],
        "formula": "Pnew = pivot + 0.82 * (Pold - pivot); six piling lower rings retain world Y=-0.65",
        "parts": dock_report,
        "shoreAttachmentFixed": True,
        "nonDockVerticesUnchanged": True,
    },
    "rockGroups": 3,
    "sculptedFixedRocks": len(rock_specs),
    "rockWorldPlacementCorrection": {
        "reason": "Restore evaluated authored join matrix; an unlinked library matrix_world cache had discarded the batch transform.",
        "localMeshReusedWithoutVertexEdits": frozen_rock_mesh is not None,
        "evaluatedBatchMatrixBlender": [list(row) for row in rock_obj.matrix_world],
        "worldGroups": rock_group_bounds,
        "worldParts": rock_parts,
        "all21AuthoredCentersMatched": True,
        "placementAssertions": rock_placement_summary,
    },
    "fixedRockRevision": "Deformed rounded boulders with individual slanted fracture planes and short one-sided fissures; no circumferential layer grooves.",
    "terrainVertices": len(terrain_mesh.vertices),
    "terrainTriangles": len(terrain_mesh.loop_triangles),
    "totalTriangles": triangles,
    "dryGeometrySha256": dry_hash,
    "previousDryGeometrySha256": previous_dry_hash,
    "dryGeometryPlanChange": "Latest user request supersedes freeze: dry radius reduced to 92 percent; original house/tree/dock geometry preserved.",
    "dryRadiusScale": .92,
    "frozenTerrainAndSubmergedGeometry": frozen_hashes,
    "previousFrozenTerrainAndSubmergedGeometry": previous_frozen_hashes,
    "terrainAndShallowBeachUnchangedInRockRevision":
        frozen_hashes[terrain.name] == previous_frozen_hashes.get(terrain.name),
    "terrainRocksAndSubmergedUnchangedInDockRevision": all(
        frozen_hashes[name] == old for name, old in previous_frozen_hashes.items()
    ),
    "submergedBodyRevision": "Latest visual review steepens side profile to .94/.87/.80/.74 for visible inverted-island volume from home camera.",
    "dryContourY": .115,
    "dryContourRadiusRange": [
        min(dry_radius(i * TAU / 2048) for i in range(2048)),
        max(dry_radius(i * TAU / 2048) for i in range(2048)),
    ],
    "shallowShelfWidth": .34,
    "shallowShelfOuterY": [-.235, -.115],
    "submergedBodyNode": "Environment_Submerged island strata",
    "submergedBodyBaseY": -1.43,
    "submergedBodyBaseRadiusRatio": .74,
    "separateSeabedOwnedByRuntime": True,
    "boatCove": {
        "angle": 1.34,
        "dryContourRadius": dry_radius(1.34),
        "boatCenterOutsideIsland": math.hypot(1.25, 5.27) > dry_radius(math.atan2(5.27, 1.25)) + .34,
        "shoreKeelOutsideIsland": math.hypot(1.30, 4.43) > dry_radius(math.atan2(4.43, 1.30)) + .34,
        "outsideActiveContourOnly": True,
    },
    "waterFloorY": FLOOR,
    "islandBodySeparatedFromOuterWaterBoundary": True,
    "allTerrainFacesUp": True,
    "houseGround": ground_height(-1.85, -1.48),
    "runtime": entry,
}
REPORT.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
print("TERRAIN_08_EXPORT_OK", json.dumps({
    "triangles": triangles, "bytes": RUNTIME.stat().st_size,
    "terrainTriangles": len(terrain_mesh.loop_triangles), "preserved": len(preserved),
}))
