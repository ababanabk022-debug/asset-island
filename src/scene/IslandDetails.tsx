import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import {
  BoxGeometry, BufferGeometry, CatmullRomCurve3, Color, CylinderGeometry,
  DoubleSide, Float32BufferAttribute, Group, IcosahedronGeometry, Matrix4,
  MeshStandardMaterial, Quaternion, TorusGeometry, TubeGeometry, Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

type V3 = [number, number, number]
type GroundHeight = (x: number, z: number) => number
type Surface = 'matte' | 'leaf' | 'wood' | 'metal' | 'light'
type Batch = { geometry: BufferGeometry; material: MeshStandardMaterial }
const palette = {
  leaf: ['#3e7250', '#57834e', '#81965a', '#9ba968'],
  clay: '#bc7856', ivory: '#eee1b8', stone: '#d0bc96',
  wood: '#9e6840', honey: '#c28e55', dark: '#674931', teal: '#467f78',
}

/** All small props share five material batches, irrespective of their number. */
class DetailBuilder {
  private parts = new Map<Surface, BufferGeometry[]>()
  add(surface: Surface, geometry: BufferGeometry, color: string, position: V3 = [0, 0, 0], scale: V3 = [1, 1, 1], rotation?: Quaternion) {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry
    if (flat !== geometry) geometry.dispose()
    flat.deleteAttribute('uv')
    flat.applyMatrix4(new Matrix4().compose(new Vector3(...position), rotation ?? new Quaternion(), new Vector3(...scale)))
    const tint = new Color(color)
    const colors = new Float32Array(flat.getAttribute('position').count * 3)
    for (let i = 0; i < colors.length; i += 3) { colors[i] = tint.r; colors[i + 1] = tint.g; colors[i + 2] = tint.b }
    flat.setAttribute('color', new Float32BufferAttribute(colors, 3))
    const parts = this.parts.get(surface) ?? []
    parts.push(flat)
    this.parts.set(surface, parts)
  }
  box(surface: Surface, color: string, position: V3, scale: V3, angle = 0) {
    this.add(surface, new BoxGeometry(1, 1, 1), color, position, scale,
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle))
  }
  rod(surface: Surface, color: string, from: V3, to: V3, radius: number, endRadius = radius) {
    const a = new Vector3(...from), b = new Vector3(...to), delta = b.clone().sub(a)
    this.add(surface, new CylinderGeometry(endRadius, radius, delta.length(), 7), color,
      a.add(b).multiplyScalar(.5).toArray() as V3, [1, 1, 1],
      new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), delta.normalize()))
  }
  pebble(color: string, position: V3, scale: V3) {
    this.add('matte', new IcosahedronGeometry(1, 1), color, position, scale)
  }
  finish(): Batch[] {
    return [...this.parts.entries()].map(([surface, parts]) => {
      const geometry = mergeGeometries(parts)!
      parts.forEach(part => part.dispose())
      geometry.computeBoundingSphere()
      return {
        geometry,
        material: new MeshStandardMaterial({
          vertexColors: true, roughness: surface === 'metal' ? .5 : .87,
          metalness: surface === 'metal' ? .5 : 0,
          ...(surface === 'leaf' ? { side: DoubleSide } : {}),
          ...(surface === 'light' ? { emissive: '#f2b26b', emissiveIntensity: .65 } : {}),
        }),
      }
    })
  }
}

function leafGeometry(length: number, width: number, lift: number) {
  const vertices: number[] = []
  const point = (t: number, side: number): V3 => [
    Math.sin(Math.PI * t) ** .8 * width * side,
    lift * Math.sin(t * Math.PI * .7) - .1 * t * t,
    length * t,
  ]
  for (let i = 0; i < 7; i++) {
    const t = i / 7, u = (i + 1) / 7
    for (const side of [-1, 1]) {
      const a = point(t, side), b = point(u, side), c = point(t, 0), d = point(u, 0)
      c[1] += .035 * Math.sin(Math.PI * t); d[1] += .035 * Math.sin(Math.PI * u)
      vertices.push(...a, ...b, ...c, ...b, ...d, ...c)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3))
  geometry.computeVertexNormals()
  return geometry
}

function plant(builder: DetailBuilder, position: V3, size: number, seed: number, flowers = false) {
  for (let i = 0; i < 9; i++) {
    const angle = i * 2.39996 + seed
    builder.add('leaf', leafGeometry(size * (.65 + .3 * Math.sin(i + seed) ** 2), size * .19, size * .5),
      palette.leaf[(i + seed) % palette.leaf.length], position, [1, 1, 1],
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle))
  }
  if (!flowers) return
  for (let i = 0; i < 4; i++) {
    const angle = i * 2.4 + seed
    const top: V3 = [position[0] + Math.cos(angle) * size * .22, position[1] + size * (.62 + i * .05), position[2] + Math.sin(angle) * size * .22]
    builder.rod('leaf', palette.leaf[0], position, top, .012)
    for (let petal = 0; petal < 5; petal++) {
      const a = petal * Math.PI * .4
      builder.add('matte', new IcosahedronGeometry(1, 1), i % 2 ? '#e5a18b' : '#f0dfb5',
        [top[0] + Math.cos(a) * .048, top[1], top[2] + Math.sin(a) * .048], [.05, .018, .033])
    }
    builder.pebble('#cc9e46', [top[0], top[1] + .014, top[2]], [.024, .018, .024])
  }
}

function pot(builder: DetailBuilder, position: V3, radius: number, seed: number) {
  const [x, y, z] = position
  builder.add('matte', new CylinderGeometry(radius, radius * .68, radius * 1.35, 12), palette.clay, [x, y + radius * .675, z])
  builder.add('matte', new TorusGeometry(radius, .022, 5, 16), '#d59a71', [x, y + radius * 1.35, z], [1, 1, 1],
    new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2))
  builder.add('matte', new CylinderGeometry(radius * .88, radius * .88, .018, 12), '#62513c', [x, y + radius * 1.32, z])
  plant(builder, [x, y + radius * 1.36, z], radius * 2.15, seed, true)
}

function beachGrass(builder: DetailBuilder, position: V3, size: number, seed: number) {
  for (let blade = 0; blade < 11; blade++) {
    const angle = blade * 2.39996 + seed
    const height = size * (.55 + .45 * Math.sin(blade * 5 + seed) ** 2)
    builder.add('leaf', leafGeometry(height * .48, .025, height), blade % 3 ? '#7e9855' : '#b1b67d',
      [position[0] + Math.cos(angle) * .065, position[1], position[2] + Math.sin(angle) * .065],
      [1, 1, 1], new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), angle))
  }
}

function lantern(builder: DetailBuilder, position: V3, hanging = false) {
  const [x, y, z] = position
  builder.box('light', '#ffdfa2', [x, y + .17, z], [.16, .23, .16])
  for (const dx of [-.1, .1]) for (const dz of [-.1, .1]) {
    builder.rod('metal', '#566556', [x + dx, y + .03, z + dz], [x + dx, y + .31, z + dz], .014)
  }
  builder.box('metal', '#4a5d51', [x, y + .02, z], [.25, .04, .25])
  builder.add('metal', new CylinderGeometry(.065, .19, .1, 4), '#4a5d51', [x, y + .35, z])
  builder.add('metal', new TorusGeometry(.055, .012, 5, 12), '#4a5d51', [x, y + .45, z])
  if (hanging) builder.rod('metal', '#4a5d51', [x, y + .49, z], [x, y + .64, z], .009)
}

function buildGarden(groundHeight?: GroundHeight) {
  const b = new DetailBuilder()
  // Lush, irregular pockets around the cabin and rocks leave the play area open.
  const beds: [number, number, number, number][] = [
    [2.1, -2.45, .58, .62], [2.65, -2.05, .54, .72], [3.1, -1.45, .53, .58],
    [3.55, -.8, .48, .48], [1.4, -2.85, .58, .55], [-.2, -2.85, .59, .62],
    [-1.2, -2.83, .59, .48], [-3.45, -1.6, .54, .5], [-3.55, -.85, .54, .42],
    [-3.62, .32, .4, .69], [-3.58, 1.15, .38, .56], [-3.33, 1.79, .37, .46],
    [3.55, 1.28, .38, .49], [3.44, 2.12, .34, .45], [1.36, -3.39, .45, .71],
    [-2.16, -3.38, .43, .61], [.66, -3.66, .41, .54],
  ]
  beds.forEach(([x, z, oldY, size], i) => {
    const y = groundHeight ? groundHeight(x, z) + .012 : oldY
    plant(b, [x, y, z], size, i + 1, i % 3 === 0)
    plant(b, [x + .23, groundHeight ? groundHeight(x + .23, z + .15) + .012 : y, z + .15], size * .58, i + 6)
    b.pebble('#b6b79b', [x - .3, groundHeight ? groundHeight(x - .3, z - .1) + .015 : y - .01, z - .1], [.16, .09, .13])
    for (let j = 0; j < 3; j++) {
      const gx = x + Math.cos(i * 1.7 + j * 2.1) * size * .62
      const gz = z + Math.sin(i * 1.7 + j * 2.1) * size * .62
      beachGrass(b, [gx, groundHeight ? groundHeight(gx, gz) + .012 : y, gz], size * .65, i + j)
    }
  })
  // House front: porch ends remain clear of the side sandstone stack.
  pot(b, [-2.84, .87, -.08], .17, 3)
  pot(b, [-.78, .87, -.08], .14, 6)
  lantern(b, [-.64, 1.36, .23], true)
  // A side step avoids the first gold row directly in front of the porch.
  b.box('wood', palette.wood, [-.35, .65, -.26], [.38, .12, .5])
  b.box('wood', palette.honey, [-.53, .72, -.26], [.24, .1, .58])
  // A short stone path curves around, rather than through, the gold and sandstone.
  const path: V3[] = [[-.32, .575, -.12], [.28, .585, -.14], [.86, .585, -.08],
    [1.43, .585, -.1], [2.03, .58, -.18], [2.6, .575, -.12], [3.2, .57, .25],
    [3.4, .55, .78], [3.45, .53, 1.4], [3.4, .49, 2], [3.25, .4, 2.65], [3.1, .29, 3.2]]
  path.forEach(([x, y, z], i) => b.add('matte', new CylinderGeometry(.25, .27, .045, 7), i % 2 ? '#c7c9bb' : '#b6baab',
    [x, groundHeight ? groundHeight(x, z) + .025 : y, z], [1, 1, .7], new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), i * .7)))
  // A few tide-tossed clusters, rather than an evenly spaced necklace.
  for (const [cx, cz, seed] of [[-3.45, 2.6, 2], [-2.5, 3.5, 5], [3.7, 2.45, 8]]) {
    for (let i = 0; i < 5; i++) {
      const a = seed + i * 2.4, distance = .06 + i * .065
      const x = cx + Math.cos(a) * distance, z = cz + Math.sin(a) * distance
      const y = groundHeight ? groundHeight(x, z) + .018 : .3
      b.pebble(i % 3 ? '#eee2c5' : '#cf9f83', [x, y, z], [.05 + i * .006, .025, .04])
    }
  }
  // Sun-bleached driftwood rests at the planted beach edge.
  const driftX = -3.65, driftZ = 2.03
  const driftY = (groundHeight?.(driftX, driftZ) ?? .3) + .05
  b.rod('wood', '#b7a480', [driftX - .28, driftY, driftZ - .14], [driftX + .28, driftY + .03, driftZ + .14], .055, .035)
  b.rod('wood', '#b7a480', [driftX, driftY, driftZ], [driftX + .13, driftY + .075, driftZ - .15], .027, .012)
  // Rolled linen and a terracotta water jug beside the porch.
  b.add('matte', new CylinderGeometry(.12, .12, .44, 10), palette.ivory, [-3.02, 1, -.52], [1, 1, 1],
    new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2))
  b.pebble(palette.clay, [-.56, .75, -.37], [.15, .19, .15])
  b.add('matte', new CylinderGeometry(.065, .09, .1, 10), palette.clay, [-.56, .95, -.37])
  return b.finish()
}

function hullGeometry() {
  // Outer keel, outer gunwale, inner gunwale and inner floor form a closed shell.
  const n = 36, vertices: number[] = [], indices: number[] = []
  const rings = [[.14, .84, -.04], [.5, 1.4, .36], [.435, 1.32, .34], [.12, .79, .03]]
  for (const [width, length, y] of rings) for (let i = 0; i < n; i++) {
    const a = i / n * Math.PI * 2
    vertices.push(Math.sin(a) * width, y + Math.abs(Math.cos(a)) ** 8 * .09, Math.cos(a) * length)
  }
  for (let ring = 0; ring < 3; ring++) for (let i = 0; i < n; i++) {
    const a = ring * n + i, b = ring * n + (i + 1) % n
    indices.push(a, b, a + n, b, b + n, a + n)
  }
  // Both bottom surfaces are capped; the boat is complete when orbiting below.
  for (let i = 1; i < n - 1; i++) {
    indices.push(0, i + 1, i)
    indices.push(3 * n, 3 * n + i, 3 * n + i + 1)
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(vertices, 3))
  g.setIndex(indices)
  g.computeVertexNormals()
  return g
}

function buildBoat() {
  const b = new DetailBuilder()
  b.add('wood', hullGeometry(), palette.teal)
  for (const inset of [0, .045]) {
    const points = Array.from({ length: 37 }, (_, i) => {
      const a = i / 36 * Math.PI * 2
      return new Vector3(Math.sin(a) * (.495 - inset), .37 + Math.abs(Math.cos(a)) ** 8 * .09, Math.cos(a) * (1.395 - inset))
    })
    b.add('wood', new TubeGeometry(new CatmullRomCurve3(points, true), 48, .025, 5, true), palette.honey)
  }
  // Interior planking and three transverse seats are visible from overhead.
  for (let i = 0; i < 5; i++) b.box('wood', i % 2 ? palette.wood : palette.honey, [(i - 2) * .13, .06, 0], [.12, .04, 1.7])
  for (const z of [-.72, .05, .72]) b.box('wood', palette.honey, [0, .3, z], [.76 - Math.abs(z) * .16, .07, .22])
  for (const z of [-.9, -.4, .4, .9]) {
    b.rod('wood', palette.dark, [-.34, .15, z], [-.41, .33, z], .025)
    b.rod('wood', palette.dark, [.34, .15, z], [.41, .33, z], .025)
  }
  b.rod('wood', palette.honey, [-.32, .39, -.75], [.5, .4, 1.02], .027)
  b.box('wood', palette.honey, [.53, .4, 1.08], [.15, .045, .43], .43)
  b.add('matte', new TorusGeometry(.14, .035, 6, 18), palette.ivory, [0, .37, -.7], [1, 1, 1],
    new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2))
  lantern(b, [0, .1, 1.02])
  return b.finish()
}

function dispose(batches: Batch[]) {
  batches.forEach(({ geometry, material }) => { geometry.dispose(); material.dispose() })
}

function Batches({ batches, shadow = true }: { batches: Batch[]; shadow?: boolean }) {
  return <>{batches.map(({ geometry, material }, i) =>
    <mesh key={i} geometry={geometry} material={material} castShadow={shadow} receiveShadow dispose={null} />)}</>
}

/** Static beds and cabin details, for optional reuse with a translated cabin. */
export function DetailGarden({ groundHeight }: { groundHeight?: GroundHeight } = {}) {
  const batches = useMemo(() => buildGarden(groundHeight), [groundHeight])
  useEffect(() => () => dispose(batches), [batches])
  return <Batches batches={batches} />
}

/** Local-island details only. The money terrace and arrival/splash routes stay clear. */
export function IslandDetails({ reduced, groundHeight }: { reduced: boolean; groundHeight?: GroundHeight }) {
  const boat = useRef<Group>(null)
  const batches = useMemo(buildBoat, [])
  const rope = useMemo(() => {
    const b = new DetailBuilder()
    b.add('matte', new TubeGeometry(new CatmullRomCurve3([
      // The exported dock shrinks around its fixed shore pivot [3.05,.48,3.013].
      // Boat X/Z follows that same .82 transform; its Y stays at water level.
      new Vector3(1.5986, .4554, 3.86334), new Vector3(2.025, .2504, 4.06834), new Vector3(2.5088, .7178, 4.56034),
    ]), 14, .014, 5), '#d8c397')
    return b.finish()
  }, [])
  useEffect(() => () => { dispose(batches); dispose(rope) }, [batches, rope])
  useFrame(({ clock }) => {
    if (!boat.current) return
    const t = clock.elapsedTime
    boat.current.position.y = .07 + (reduced ? 0 : Math.sin(t * .9) * .023)
    boat.current.rotation.z = reduced ? 0 : Math.sin(t * .7) * .015
    boat.current.rotation.x = reduced ? 0 : Math.sin(t * .8 + .6) * .01
  })
  return <group name="Island living details">
    <DetailGarden groundHeight={groundHeight} />
    <group ref={boat} position={[1.574, .07, 4.86374]} rotation={[0, -.06, 0]} scale={.82}>
      <Batches batches={batches} shadow={false} />
    </group>
    <Batches batches={rope} shadow={false} />
  </group>
}

const palmCrowns: V3[] = [
  [-3.7 + .45820937981727283, 4.2, -.1],
  [.65 - .17129947946690205, 4.3, -3],
  [-3 - .256482237290663, 3.6, -2.95],
]

function featherLeaflet(start: Vector3, forward: Vector3, side: Vector3, length: number, width: number, curl: number) {
  const positions: number[] = []
  const point = (t: number, edge: number) => {
    // Narrow pinnae sweep towards the frond tip, fold at their midrib, and curl down.
    const p = start.clone().addScaledVector(side, length * t).addScaledVector(forward, length * .32 * t)
    p.y += .08 * Math.sin(t * Math.PI) - curl * t * t
    p.addScaledVector(forward, Math.sin(t * Math.PI) ** .7 * width * edge)
    if (!edge) p.y += .017 * Math.sin(t * Math.PI)
    return p.toArray()
  }
  for (let i = 0; i < 5; i++) {
    const t = i / 5, u = (i + 1) / 5
    for (const edge of [-1, 1]) {
      const a = point(t, edge), b = point(u, edge), c = point(t, 0), d = point(u, 0)
      positions.push(...a, ...b, ...c, ...b, ...d, ...c)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(positions, 3))
  g.computeVertexNormals()
  return g
}

function buildPalmCrown(seed: number) {
  const b = new DetailBuilder()
  const greens = ['#668c48', '#7f9e54', '#4f7c46']
  for (let frond = 0; frond < 10; frond++) {
    const angle = frond * Math.PI * 2 / 10 + seed * .51 + Math.sin(frond * 8 + seed) * .12
    const length = 1.5 + .25 * Math.sin(frond * 5 + seed) ** 2
    const forward = new Vector3(Math.cos(angle), 0, Math.sin(angle))
    const side = new Vector3(-forward.z, 0, forward.x)
    const arch = .36 + .1 * Math.sin(frond + seed) ** 2
    const stem = (t: number) => forward.clone().multiplyScalar(length * t)
      .add(new Vector3(0, arch * Math.sin(Math.PI * t) - .48 * t * t, 0))
    const stemPoints = Array.from({ length: 9 }, (_, i) => stem(i / 8))
    // Stem and foliage use the same vertex-coloured batch.
    b.add('leaf', new TubeGeometry(new CatmullRomCurve3(stemPoints), 16, .014, 4), '#8d9b59')
    for (let pair = 0; pair < 16; pair++) {
      const t = .13 + pair / 16 * .83
      const pinnaLength = (.12 + .43 * Math.sin(Math.PI * t) ** .8) * (.95 + .05 * Math.sin(pair * 5 + seed))
      for (const sign of [-1, 1]) {
        const stagger = sign === 1 ? .014 : 0
        const start = stem(t + stagger)
        b.add('leaf', featherLeaflet(start, forward, side.clone().multiplyScalar(sign), pinnaLength,
          .052 + .018 * Math.sin(Math.PI * t), .08 + .15 * t), greens[(frond + pair + (sign + 1) / 2) % 3])
      }
    }
  }
  // Compact young shoots and coconuts connect the feather canopy to the existing trunk.
  for (let i = 0; i < 3; i++) {
    b.add('leaf', leafGeometry(.44 + i * .03, .045, .54), '#9aab62', [0, .025, 0], [1, 1, 1],
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), i * 2.1 + seed))
  }
  for (let i = 0; i < 4; i++) {
    const angle = i * 2.4 + seed
    b.add('matte', new IcosahedronGeometry(1, 1), i % 2 ? '#8b8150' : '#6e7145',
      [Math.cos(angle) * .125, -.12 - i % 2 * .06, Math.sin(angle) * .125], [.09, .12, .085])
  }
  return b.finish()
}

/**
 * Replacement crowns for the three authored palms. Hide the original "Palm leaf"
 * environment meshes, retain their trunks, and mount this at the same world origin.
 */
export function PalmCanopies({ reduced }: { reduced: boolean }) {
  const groups = useRef<(Group | null)[]>([])
  const crowns = useMemo(() => [22, 36, 51].map(buildPalmCrown), [])
  useEffect(() => () => crowns.forEach(dispose), [crowns])
  useFrame(({ clock }) => {
    for (let i = 0; i < groups.current.length; i++) {
      const crown = groups.current[i]
      if (!crown) continue
      crown.rotation.x = reduced ? 0 : Math.sin(clock.elapsedTime * .47 + i * 2.3) * .006
      crown.rotation.z = reduced ? 0 : Math.sin(clock.elapsedTime * .39 + i) * .008
    }
  })
  return <group name="Feather palm crowns">
    {crowns.map((batches, i) => <group key={i} position={palmCrowns[i]} ref={group => { groups.current[i] = group }}>
      <Batches batches={batches} />
    </group>)}
  </group>
}
