import RAPIER from '@dimforge/rapier3d-compat'
import { GOLD, STONE, STONES_PER_GOLD, type Transaction } from '../domain/reserve.ts'
import { SMALL_SCALE, type Piece, type Vec3 } from './reserveMotion.ts'
import { physicsReady, type Impact, type PhysicsAssets, type Shape } from './reservePhysics.ts'
import { CONTAINER } from './containerConfig.ts'
import { createShoreBoundary, type ShoreBoundary } from './shoreBoundary.ts'
import { connectedParts, type CollisionProxy } from './collisionMesh.ts'

export { physicsReady }
export interface FreePhysicsAssets extends PhysicsAssets {
  obstacles?: { vertices: Float32Array; indices: Uint32Array }[]
  collisionProxy?: CollisionProxy
}
export interface FreePiece extends Piece { id: string; spent?: boolean }
interface Item {
  piece: FreePiece
  body: RAPIER.RigidBody
  collider: RAPIER.Collider
  radius: number
  thickness: number
  born: number
  wet: boolean
  merging: boolean
  departing?: { at: number; from: Vec3; rotation: [number, number, number, number] }
}
interface Hull {
  vertices: Float32Array; indices: Uint32Array; radius: number; bottom: number; thickness: number
  mass: number; center: RAPIER.Vector; inertia: RAPIER.Vector; frame: RAPIER.Rotation
}
interface Merge { ids: string[]; target: Vec3; at: number; value: number; kind: Piece['kind'] }
interface Occupied { x: number; y: number; z: number; radius: number }
const hulls = new WeakMap<Shape, Hull>()


interface SupportMap { values: Float32Array; count: number; step: number; origin: number }
const supportMaps = new WeakMap<FreePhysicsAssets, SupportMap>()
const STEP = 1 / 60
const DEPART_SECONDS = .48
const MERGE_SECONDS = .2
const noise = (i: number) => { const n = Math.sin(i * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n) }
const scaleOf = (piece: Pick<Piece, 'kind' | 'value'>) => SMALL_SCALE * Math.cbrt(piece.value / (piece.kind === 'gold' ? GOLD : STONE))
const length = (v: RAPIER.Vector) => Math.hypot(v.x, v.y, v.z)

/**
 * One persistent world, independent of ledger animation boundaries.
 * `amount` is represented by all non-departing bodies at every commit, including
 * bodies still in the air. Departures reserve their money immediately, so a
 * following expense cannot select the same stone twice.
 */
export class FreeReservePhysics {
  readonly world: RAPIER.World
  readonly assets: FreePhysicsAssets
  readonly boundary: ShoreBoundary
  impacts: Impact[] = []
  time = 0
  private items: Item[] = []
  private amount = 0
  private serial = 0
  private remainder = 0
  private merges: Merge[] = []
  private completedIds = new Set<string>()
  private colliders = new Map<number, Item>()
  private events = new RAPIER.EventQueue(true)
  private drag: { id: string; target: Vec3 } | null = null
  private actionUntil = 0
  private reduced: boolean
  private disposed = false
  readonly obstacleColliderCount: number
  private supportMap: SupportMap
  private terrainCollider: RAPIER.Collider
  private supportColliders = new Set<number>()
  private terrainMaximum: number

  constructor(assets: FreePhysicsAssets, amount: number, reduced = false) {
    this.assets = assets
    this.boundary = createShoreBoundary(assets.terrain)
    this.terrainMaximum = -Infinity
    for (let i = 1; i < assets.terrain.vertices.length; i += 3) this.terrainMaximum = Math.max(this.terrainMaximum, assets.terrain.vertices[i])
    this.reduced = reduced
    this.world = new RAPIER.World({ x: 0, y: -19.6, z: 0 })
    this.world.timestep = STEP
    this.world.numSolverIterations = 6
    this.terrainCollider = this.world.createCollider(RAPIER.ColliderDesc.trimesh(assets.terrain.vertices, assets.terrain.indices).setFriction(.82).setRestitution(.16))
    this.supportColliders.add(this.terrainCollider.handle)
    if (assets.collisionProxy) {
      // Keep the original exported mesh for exact shore/height/contact checks.
      // Only the solver uses the baked, independently validated contact mesh.
      this.terrainCollider.setCollisionGroups(0)
      const contact = assets.collisionProxy.terrain
      this.world.createCollider(RAPIER.ColliderDesc.trimesh(contact.vertices, contact.indices).setFriction(.82).setRestitution(.16))
    }
    const obstacles = assets.collisionProxy?.obstacles ?? (assets.obstacles ?? []).flatMap(connectedParts)
    this.obstacleColliderCount = obstacles.length
    for (const obstacle of obstacles) {
      const collider = this.world.createCollider(RAPIER.ColliderDesc.trimesh(obstacle.vertices, obstacle.indices).setFriction(.68).setRestitution(.28))
      this.supportColliders.add(collider.handle)
    }
    const halfHeight = (CONTAINER.wallTop - CONTAINER.floorY) / 2
    for (const [i, a] of this.boundary.points.entries()) {
      const b = this.boundary.points[(i + 1) % this.boundary.points.length]
      const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz)
      const nx = dz / length, nz = -dx / length, angle = Math.atan2(nz, nx)
      // The inner face sits just inside the true dry contour. The full-height
      // invisible wall catches lifted/falling bodies, not only settled piles.
      this.world.createCollider(RAPIER.ColliderDesc.cuboid(.12, halfHeight, length / 2 + .025)
        .setTranslation((a[0] + b[0]) / 2 + nx * .085, CONTAINER.floorY + halfHeight, (a[1] + b[1]) / 2 + nz * .085)
        .setRotation({ x: 0, y: -Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) }).setFriction(.48).setRestitution(.3))
    }
    this.world.updateSceneQueries()
    // Cache a conservative footprint height field during scene preparation.
    // Rebuilding a saved large balance then uses cheap array lookups, not
    // thousands of expensive convex/triangle overlap queries.
    let supportMap = supportMaps.get(assets)
    if (!supportMap) {
      const count = 128, origin = -this.boundary.maxRadius, step = this.boundary.maxRadius * 2 / (count - 1)
      const values = new Float32Array(count * count)
      for (let x = 0; x < count; x++) for (let z = 0; z < count; z++) values[x * count + z] = this.staticHeight(origin + x * step, origin + z * step)
      supportMap = { values, count, step, origin }; supportMaps.set(assets, supportMap)
    }
    this.supportMap = supportMap
    this.sync(amount)
  }

  /** Explicit reset for import, account switch, reduced motion, or skip only. */
  sync(amount: number, force = false) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid physical reserve amount')
    if (!force && amount === this.amount && this.items.length) {
      this.drag = null
      for (const merge of this.merges) this.finishMerge(merge)
      this.merges = []
      for (const item of [...this.items]) {
        if (item.departing) this.remove(item)
        else item.merging = false
      }
      let sand = this.items.filter(item => item.piece.kind === 'sand')
      while (sand.reduce((sum, item) => sum + item.piece.value, 0) >= GOLD) {
        this.beginMerge(sand, GOLD, 'gold', true)
        sand = this.items.filter(item => item.piece.kind === 'sand')
      }
      this.impacts = []; this.actionUntil = this.time
      return
    }
    this.drag = null; this.merges = []; this.impacts = []; this.actionUntil = this.time
    for (const item of [...this.items]) this.remove(item)
    this.amount = amount
    const values = this.denominations(amount)
    const occupied: Occupied[] = []
    values.forEach((piece, i) => {
      const h = this.hull(this.assets[piece.kind]), scale = scaleOf(piece), radius = h.radius * scale
      let x = 0, z = 0, y = Infinity
      for (let attempt = 0; attempt < 24; attempt++) {
        const index = i + attempt * 17.324
        const r = .45 + Math.sqrt(index % 108) * .55
        const a = index * 2.399963 + Math.floor(i / 108) * 1.23
        const [candidateX, candidateZ] = this.boundary.project(Math.cos(a) * r + .12, Math.sin(a) * r + .25, radius + .12)
        const support = this.footprintHeight(candidateX, candidateZ, radius)
        if (support > 1.55) continue
        const candidateY = this.freeHeight(candidateX, candidateZ, radius, support + radius + .015, occupied)
        if (candidateY < y) { x = candidateX; y = candidateY; z = candidateZ }
        // Prefer the first naturally spread, unobstructed supported candidate.
        if (candidateY < support + radius + .025) break
      }
      if (!Number.isFinite(y)) y = this.freeHeight(x, z, radius, this.footprintHeight(x, z, radius) + radius + .015, occupied)
      const item = this.add(piece.kind, piece.value, [x, y, z])
      // Saved value has no saved velocity. Let the supported natural pile settle;
      // the reduced-motion view alone starts at a quiet supported pose.
      if (this.reduced) item.body.sleep()
      occupied.push({ x, y, z, radius })
    })
    this.remainder = 0
  }
  setReduced(reduced: boolean) {
    if (this.reduced === reduced) return
    this.reduced = reduced
    if (reduced) this.sync(this.amount, true)
    else for (const item of this.items) item.body.wakeUp()
  }

  commit(transaction: Transaction) {
    if (this.completedIds.has(transaction.id)) return
    if (!Number.isSafeInteger(transaction.after) || transaction.after < 0 ||
      transaction.after !== transaction.before + (transaction.type === 'income' ? transaction.amount : -transaction.amount)) throw new Error('Invalid physical transaction')
    this.completedIds.add(transaction.id)
    if (this.completedIds.size > 512) this.completedIds.delete(this.completedIds.values().next().value!)
    if (this.amount !== transaction.before) this.sync(transaction.before)
    if (this.reduced) { this.sync(transaction.after); return }
    if (transaction.type === 'income') this.income(transaction.amount)
    else this.expense(transaction.amount)
    this.amount = transaction.after
    this.actionUntil = Math.max(this.actionUntil, this.time + .9)
    this.compactIfNeeded()
    this.assertValue()
  }

  private denominations(amount: number) {
    const values: { kind: Piece['kind']; value: number }[] = []
    while (amount >= GOLD) { values.push({ kind: 'gold', value: GOLD }); amount -= GOLD }
    while (amount > 0) { values.push({ kind: 'sand', value: Math.min(STONE, amount) }); amount -= STONE }
    return values
  }

  private income(amount: number) {
    // Large transfers arrive as whole denominations instead of producing ten
    // thousand simultaneous fragments. Normal deposits still visibly form gold.
    const values = amount <= GOLD
      ? Array.from({ length: Math.ceil(amount / STONE) }, (_, i) => ({ kind: 'sand' as const, value: Math.min(STONE, amount - i * STONE) }))
      : this.denominations(amount)
    const seed = this.serial
    const occupied: Occupied[] = this.items.filter(item => !item.departing).map(item => ({ ...item.body.translation(), radius: item.radius }))
    let sandIndex = 0, goldIndex = 0
    for (const [i, piece] of values.entries()) {
      // A transfer's preceding golds must not push its change sandstone into
      // the fifteenth "cloud layer" underneath the ground.
      const dropIndex = piece.kind === 'sand' ? sandIndex++ : goldIndex++
      const n = this.serial + 1, slot = (seed + dropIndex) % 14, a = (seed + dropIndex) * 2.399963
      const r = Math.sqrt((slot + .5) / 14) * CONTAINER.dropRadius
      const coreRadius = this.hull(this.assets[piece.kind]).radius * scaleOf(piece)
      const radius = coreRadius + (coreRadius < .05 ? .012 : 0)
      // The short vertical stream stays entirely below the thin cloud, rather
      // than placing later layers visibly above its surface.
      let position: Vec3 = [CONTAINER.cloud[0] + Math.cos(a) * r, CONTAINER.cloud[1] - .4 - Math.floor(dropIndex / 14) * .42, CONTAINER.cloud[2] + Math.sin(a) * r]
      const bulk = values.length > 16 && piece.kind === 'gold'
      let shortFall = bulk && dropIndex >= 6
      if (piece.kind === 'gold') {
        const angle = dropIndex % 3 * Math.PI * 2 / 3
        position = [CONTAINER.cloud[0] + Math.cos(angle) * .73, CONTAINER.cloud[1] - .4 - Math.floor(dropIndex / 3) * .86, CONTAINER.cloud[2] + Math.sin(angle) * .73]
      }
      if (shortFall) {
        // The first golds establish the cloud entry. A huge transfer then fills
        // free space with a short settling fall, never overlapping bulk hulls in
        // one tiny emitter or queuing seconds of mandatory animation.
        position = this.scatterBirth(i, radius, occupied)
      } else {
        // Mixed denominations and rapid clicks share the same real cloud
        // volume. Find a free height before creating a body, so a new tiny
        // stone cannot start inside a gold already falling through that lane.
        position[1] = this.cloudHeight(position[0], position[2], radius, position[1], occupied)
        if (position[1] < this.footprintHeight(position[0], position[2], radius) + radius + .04) {
          position = this.scatterBirth(seed + i, radius, occupied)
          shortFall = true
        }
      }
      const item = this.add(piece.kind, piece.value, position)
      occupied.push({ ...item.body.translation(), radius: item.radius })
      item.body.setLinvel({ x: (noise(n + 3) - .5) * .18, y: shortFall ? -.8 : -3.6 - dropIndex % 4 * .25, z: (noise(n + 4) - .5) * .18 }, true)
      item.body.setAngvel({ x: noise(n + 8) * 2 - 1, y: noise(n + 5) * 2 - 1, z: noise(n + 6) * 2 - 1 }, true)
    }
  }

  private expense(amount: number) {
    // A transaction can interrupt a transmutation without resetting the world.
    for (const item of this.items) item.merging = false
    this.merges = []
    while (amount > 0) {
      const available = this.items.filter(item => !item.departing)
      const sands = available.filter(item => item.piece.kind === 'sand')
      const pool = sands.length ? sands : available
      const item = pool.sort((a, b) => b.body.translation().y - a.body.translation().y)[0]
      if (!item) throw new Error('Physical reserve cannot fund transaction')
      if (item.piece.kind === 'gold' && amount < item.piece.value) {
        this.fracture(item)
        continue
      }
      if (amount >= item.piece.value) {
        amount -= item.piece.value
        this.depart(item)
      } else {
        const pose = this.pose(item), originalValue = item.piece.value
        this.remove(item)
        // Only this fractional stone changes shape; untouched objects keep ids.
        const rest = this.add('sand', originalValue - amount, pose.position, pose.orientation, pose.id)
        rest.body.setLinvel({ x: 0, y: .12, z: 0 }, true)
        this.depart(this.add('sand', amount, pose.position, pose.orientation))
        amount = 0
      }
    }
  }

  private fracture(item: Item) {
    const pose = this.pose(item), count = Math.ceil(item.piece.value / STONE)
    this.remove(item)
    this.impact(pose.position, .85, true, false, 'fracture')
    for (let i = 0; i < count; i++) {
      const a = i * 2.399963, r = .16 + Math.sqrt(i % 16) * .14
      const value = Math.min(STONE, pose.value - i * STONE)
      const radius = this.hull(this.assets.sand).radius * scaleOf({ kind: 'sand', value })
      const [x, z] = this.boundary.project(pose.position[0] + Math.cos(a) * r, pose.position[2] + Math.sin(a) * r, radius + .06)
      const position: Vec3 = [x, Math.max(pose.position[1] + .12 + Math.floor(i / 16) * .26,
        this.footprintHeight(x, z, radius) + radius + .015), z]
      const fragment = this.add('sand', value, position)
      fragment.body.setLinvel({ x: Math.cos(a) * .55, y: .6 + noise(i) * .5, z: Math.sin(a) * .55 }, true)
      fragment.body.setAngvel({ x: noise(i + 1) * 2, y: noise(i + 3), z: -noise(i + 4) * 2 }, true)
    }
  }

  private depart(item: Item) {
    if (this.drag?.id === item.piece.id) this.drag = null
    const pose = this.pose(item)
    item.departing = { at: this.time, from: pose.position, rotation: pose.orientation! }
    item.piece.spent = true; item.merging = false
    // A reserved withdrawal is now a visual trajectory, not another obstacle.
    // It cannot push or re-enter the retained pile on its way out.
    item.collider.setEnabled(false)
    item.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true)
  }

  private hull(shape: Shape): Hull {
    const existing = hulls.get(shape)
    if (existing) return existing
    const probe = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic())
    // Decorative bevels produce hundreds of near-identical convex vertices.
    // The extreme support points retain the exported silhouette and bounds with
    // at most 26 vertices, substantially reducing pile contact work on the CPU.
    const points = new Set<number>()
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      if (!x && !y && !z) continue
      let best = -Infinity, index = 0
      for (let i = 0; i < shape.vertices.length; i += 3) {
        const dot = shape.vertices[i] * x + shape.vertices[i + 1] * y + shape.vertices[i + 2] * z
        if (dot > best) { best = dot; index = i }
      }
      points.add(index)
    }
    const support = new Float32Array([...points].flatMap(index => [...shape.vertices.slice(index, index + 3)]))
    const descriptor = RAPIER.ColliderDesc.convexHull(support)
    if (!descriptor) { this.world.removeRigidBody(probe); throw new Error('Invalid stone hull') }
    const collider = this.world.createCollider(descriptor.setDensity(2.4), probe)
    const vertices = new Float32Array(collider.vertices()), indices = new Uint32Array(collider.indices()!)
    let radius = 0, bottom = Infinity
    const minimum = [Infinity, Infinity, Infinity], maximum = [-Infinity, -Infinity, -Infinity]
    for (let i = 0; i < vertices.length; i += 3) {
      radius = Math.max(radius, Math.hypot(vertices[i], vertices[i + 1], vertices[i + 2]))
      bottom = Math.min(bottom, vertices[i + 1])
      for (let axis = 0; axis < 3; axis++) {
        minimum[axis] = Math.min(minimum[axis], vertices[i + axis])
        maximum[axis] = Math.max(maximum[axis], vertices[i + axis])
      }
    }
    const thickness = Math.min(...maximum.map((value, i) => value - minimum[i]))
    const hull = { vertices, indices, radius, bottom, thickness, mass: probe.mass(), center: probe.localCom(), inertia: probe.principalInertia(), frame: probe.principalInertiaLocalFrame() }
    hulls.set(shape, hull)
    this.world.removeRigidBody(probe)
    return hull
  }

  private add(kind: Piece['kind'], value: number, position: Vec3, orientation?: Piece['orientation'], id?: string) {
    const serial = ++this.serial
    const h = this.hull(this.assets[kind]), scale = scaleOf({ kind, value })
    // Cent-sized hulls are smaller than the solver's multi-contact tolerance
    // after a heavy stone pushes them against a zero-thickness terrain face.
    // A 1.2 cm rounded shell gives only these tiny fragments a robust contact
    // surface. Their visible geometry, mass, inertia and every full unit remain
    // unchanged; support still comes from the real terrain and real props.
    const skin = h.radius * scale < .05 ? .012 : 0, radius = h.radius * scale + skin
    const [x, z] = this.boundary.project(position[0], position[2], radius + .04)
    if (Math.hypot(x - position[0], z - position[2]) > 1e-6) {
      // New denominations may be larger than their source fragments. Birth
      // positions are safe before creating a body; live bodies never teleport.
      position = [x, Math.max(position[1], this.footprintHeight(x, z, radius) + radius + .015), z]
    }
    const piece: FreePiece = { id: id ?? `reserve-${serial}`, kind, value, position, orientation, factor: 1, rotation: noise(serial) * Math.PI * 2, centered: true }
    const q = orientation ?? [0, Math.sin(piece.rotation / 2), 0, Math.cos(piece.rotation / 2)]
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(...position)
      .setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }).setLinearDamping(.22).setAngularDamping(1.1))
    const vertices = Float32Array.from(h.vertices, n => n * scale)
    const descriptor = RAPIER.ColliderDesc.convexMesh(vertices, h.indices)
    if (!descriptor) { this.world.removeRigidBody(body); throw new Error('Invalid scaled stone hull') }
    const collider = this.world.createCollider(descriptor.setMassProperties(h.mass * scale ** 3,
      { x: h.center.x * scale, y: h.center.y * scale, z: h.center.z * scale },
      { x: h.inertia.x * scale ** 5, y: h.inertia.y * scale ** 5, z: h.inertia.z * scale ** 5 }, h.frame)
      .setFriction(.78).setRestitution(.18).setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), body)
    if (skin) collider.setShape(new RAPIER.RoundConvexPolyhedron(collider.vertices(), collider.indices(), skin))
    const item: Item = { body, collider, piece, born: this.time, radius, thickness: h.thickness * scale + skin * 2, wet: position[1] < CONTAINER.waterY, merging: false }
    this.items.push(item); this.colliders.set(collider.handle, item)
    return item
  }

  private remove(item: Item) {
    if (this.drag?.id === item.piece.id) this.drag = null
    this.colliders.delete(item.collider.handle)
    this.world.removeRigidBody(item.body)
    const index = this.items.indexOf(item)
    if (index >= 0) this.items.splice(index, 1)
  }

  private pose(item: Item): FreePiece {
    const p = item.body.translation(), q = item.body.rotation()
    let factor = 1
    if (item.departing) factor = Math.max(.001, 1 - Math.max(0, (this.time - item.departing.at - .24) / .24))
    return { ...item.piece, factor, position: [p.x, p.y, p.z], orientation: [q.x, q.y, q.z, q.w] }
  }
  pieces(): FreePiece[] { return this.items.map(item => this.pose(item)) }

  startDrag(id: string, target: Vec3) {
    const item = this.items.find(item => item.piece.id === id && !item.departing && !item.merging)
    if (!item || this.reduced) return false
    this.drag = { id, target: this.projectDragTarget(target, item.radius) }
    item.body.wakeUp()
    return true
  }
  moveDrag(target: Vec3) {
    if (!this.drag) return
    const item = this.items.find(item => item.piece.id === this.drag?.id)
    if (item) this.drag.target = this.projectDragTarget(target, item.radius)
  }
  endDrag() { this.drag = null }
  nudge(velocity: [number, number]) {
    if (this.reduced || !velocity.every(Number.isFinite)) return
    const magnitude = Math.hypot(...velocity), scale = magnitude > 1.4 ? 1.4 / magnitude : 1
    for (const item of this.items) {
      if (item.departing || item.merging || item.piece.id === this.drag?.id) continue
      const m = item.body.mass(), v = item.body.linvel()
      const x = v.x + velocity[0] * scale, z = v.z + velocity[1] * scale
      const speed = Math.hypot(x, z), cap = speed > 3.4 ? 3.4 / speed : 1
      item.body.setLinvel({ x: x * cap, y: v.y + .015 * Math.min(magnitude, 1), z: z * cap }, true)
      item.body.applyTorqueImpulse({ x: velocity[1] * scale * m * item.radius ** 2 * .12, y: 0, z: -velocity[0] * scale * m * item.radius ** 2 * .12 }, true)
    }
  }
  projectDragTarget(target: Vec3, radius: number): Vec3 {
    const [x, z] = this.boundary.project(target[0], target[2], radius + .08)
    return [x, Math.max(this.terrainHeight(x, z) + radius, Math.min(3.8, target[1])), z]
  }
  terrainHeight(x: number, z: number) {
    const hit = this.terrainCollider.castRay(new RAPIER.Ray({ x, y: 12, z }, { x: 0, y: -1, z: 0 }), 20, true)
    return hit >= 0 ? 12 - hit : CONTAINER.floorY
  }
  private staticHeight(x: number, z: number) {
    const ray = new RAPIER.Ray({ x, y: 12, z }, { x: 0, y: -1, z: 0 })
    // Only visible terrain and props can support a birth pose. Invisible shore
    // walls must not raise nearby samples to their full collision height.
    const hit = this.world.castRay(ray, 20, true, undefined, undefined, undefined, undefined, collider => this.supportColliders.has(collider.handle))
    return hit ? 12 - hit.toi : CONTAINER.floorY
  }
  private footprintHeight(x: number, z: number, radius: number) {
    const { count, origin, step, values } = this.supportMap
    const minX = Math.max(0, Math.floor((x - radius - origin) / step)), maxX = Math.min(count - 1, Math.ceil((x + radius - origin) / step))
    const minZ = Math.max(0, Math.floor((z - radius - origin) / step)), maxZ = Math.min(count - 1, Math.ceil((z + radius - origin) / step))
    let height = CONTAINER.floorY
    const footprint = (radius + step) ** 2
    for (let i = minX; i <= maxX; i++) for (let j = minZ; j <= maxZ; j++) {
      if ((origin + i * step - x) ** 2 + (origin + j * step - z) ** 2 <= footprint) height = Math.max(height, values[i * count + j])
    }
    return height
  }
  /** Lowest free sphere position in this vertical column. A flying stone leaves
   * usable room beneath it, while the fourth and later settled layers still
   * count as real obstacles. This avoids a height cutoff that overlapped large
   * deposits on the smaller island and launched the resulting pile. */
  private freeHeight(x: number, z: number, radius: number, base: number, occupied: Occupied[]) {
    const intervals: [number, number][] = []
    for (const other of occupied) {
      const squared = (x - other.x) ** 2 + (z - other.z) ** 2, combined = radius + other.radius + .015
      if (squared >= combined * combined) continue
      const half = Math.sqrt(combined * combined - squared)
      intervals.push([other.y - half, other.y + half])
    }
    intervals.sort((a, b) => a[0] - b[0])
    let height = base
    for (const [low, high] of intervals) {
      if (height < low) break
      if (height <= high) height = high + .002
    }
    return height
  }
  private cloudHeight(x: number, z: number, radius: number, top: number, occupied: Occupied[]) {
    const intervals: [number, number][] = []
    for (const other of occupied) {
      const squared = (x - other.x) ** 2 + (z - other.z) ** 2, combined = radius + other.radius + .015
      if (squared >= combined * combined) continue
      const half = Math.sqrt(combined * combined - squared)
      intervals.push([other.y - half, other.y + half])
    }
    intervals.sort((a, b) => b[1] - a[1])
    let height = top
    for (const [low, high] of intervals) {
      if (height > high) break
      if (height >= low) height = low - .002
    }
    return height
  }
  private scatterBirth(i: number, radius: number, occupied: Occupied[]): Vec3 {
    let x = 0, z = 0, y = Infinity
    for (let attempt = 0; attempt < 16; attempt++) {
      const index = i + attempt * 17.324
      const spread = .45 + Math.sqrt(index % 108) * .55, angle = index * 2.399963
      const [cx, cz] = this.boundary.project(Math.cos(angle) * spread, Math.sin(angle) * spread, radius + .12)
      const support = this.footprintHeight(cx, cz, radius)
      if (support > 1.55) continue
      const cy = this.freeHeight(cx, cz, radius, support + radius + .16, occupied)
      if (cy < y) { x = cx; z = cz; y = cy }
      if (cy < support + radius + .18) break
    }
    return [x, Number.isFinite(y) ? y : this.freeHeight(x, z, radius, this.footprintHeight(x, z, radius) + radius + .16, occupied), z]
  }
  private impact(position: Vec3, strength: number, gold = false, water = false, effect?: Impact['effect']) {
    this.impacts.push({ position, time: this.time, strength, gold, water, effect })
    if (this.impacts.length > 72) this.impacts.shift()
  }

  private beginMerge(pool: Item[], value: number, kind: Piece['kind'], immediate = false) {
    let left = value
    const chosen: Item[] = []
    for (const item of pool) {
      if (left <= 0) break
      if (item.piece.value > left) {
        const pose = this.pose(item), velocity = item.body.linvel()
        this.remove(item)
        const rest = this.add('sand', pose.value - left, pose.position, pose.orientation, pose.id)
        rest.body.setLinvel(velocity, true)
        const part = this.add('sand', left, pose.position, pose.orientation)
        chosen.push(part); left = 0
      } else { chosen.push(item); left -= item.piece.value }
    }
    if (left !== 0) throw new Error('Incomplete physical merge')
    const target = chosen.reduce<Vec3>((center, item) => {
      const p = item.body.translation(), fraction = item.piece.value / value
      return [center[0] + p.x * fraction, center[1] + p.y * fraction, center[2] + p.z * fraction]
    }, [0, 0, 0])
    const radius = this.hull(this.assets[kind]).radius * scaleOf({ kind, value })
    const [x, z] = this.boundary.project(target[0], target[2], radius + .06)
    target[0] = x; target[2] = z
    target[1] = Math.max(target[1], this.footprintHeight(x, z, radius) + radius + .015)
    for (const item of chosen) item.merging = true
    const merge: Merge = { ids: chosen.map(item => item.piece.id), target, at: this.time, value, kind }
    if (immediate) this.finishMerge(merge)
    else this.merges.push(merge)
  }
  private finishMerge(merge: Merge) {
    for (const id of merge.ids) {
      const item = this.items.find(item => item.piece.id === id)
      if (item) this.remove(item)
    }
    const item = this.add(merge.kind, merge.value, merge.target)
    item.body.setLinvel({ x: 0, y: .18, z: 0 }, true)
    if (merge.kind === 'gold') this.impact(merge.target, .85, true, false, 'merge')
    this.actionUntil = Math.max(this.actionUntil, this.time + .25)
  }
  private compactIfNeeded() {
    // A click storm must not produce an unbounded physics queue. Keep full gold
    // and a modest temporary sandstone pool; compact only the affected pieces.
    let pool = this.items.filter(item => !item.departing && !item.merging && item.piece.kind === 'sand' && item.piece.id !== this.drag?.id)
    // Keep a complete denomination and headroom for another rapid deposit.
    // A normal threshold-crossing must still fall and visibly gather.
    while (pool.length > STONES_PER_GOLD + 60 && pool.reduce((sum, item) => sum + item.piece.value, 0) >= GOLD) {
      this.beginMerge(pool, GOLD, 'gold', true)
      pool = this.items.filter(item => !item.departing && !item.merging && item.piece.kind === 'sand' && item.piece.id !== this.drag?.id)
    }
    let partial = pool.filter(item => item.piece.value < STONE)
    while (partial.length > 32) {
      const value = Math.min(STONE, partial.reduce((sum, item) => sum + item.piece.value, 0))
      this.beginMerge(partial, value, 'sand', true)
      partial = this.items.filter(item => !item.departing && !item.merging && item.piece.kind === 'sand' &&
        item.piece.value < STONE && item.piece.id !== this.drag?.id)
    }
    // Departures are already absent from the balance. If a stress burst exceeds
    // the render budget, finish its oldest outgoing visual trails early.
    // At the larger denomination, two concurrent 200-stone gathers can also
    // fill the budget: finish an already-started gather, preserving its value.
    while (this.items.length > 420) {
      const oldest = this.items.find(item => item.departing)
      if (oldest) this.remove(oldest)
      else {
        const merge = this.merges.shift()
        if (!merge) break
        this.finishMerge(merge)
      }
    }
  }
  private scheduleMerges() {
    let pool = this.items.filter(item => !item.departing && !item.merging && item.piece.kind === 'sand' &&
      item.piece.id !== this.drag?.id && this.time - item.born >= .62 && (() => {
        const p = item.body.translation()
        // Raised clouds must not transmute a whole deposit halfway down the
        // sky. Begin gathering only once each participant reaches the island
        // or a real prop/stack close to its collision surface.
        return p.y <= Math.max(2.25, this.staticHeight(p.x, p.z) + item.radius + .9)
      })())
    while (pool.reduce((sum, item) => sum + item.piece.value, 0) >= GOLD) {
      const origin = pool[0].body.translation()
      pool.sort((a, b) => {
        const p = a.body.translation(), q = b.body.translation()
        return Math.hypot(p.x - origin.x, p.z - origin.z) - Math.hypot(q.x - origin.x, q.z - origin.z)
      })
      this.beginMerge(pool, GOLD, 'gold')
      pool = pool.filter(item => !item.merging && this.items.includes(item))
    }
  }

  advance(delta: number) {
    if (this.disposed || this.reduced) return
    this.remainder += Math.min(Math.max(delta, 0), STEP * 2)
    // At most two fixed steps per displayed frame. One expensive frame must
    // not trigger a five-step catch-up spike and perpetuate itself.
    let steps = 0
    while (this.remainder >= STEP && steps++ < 2) { this.tick(); this.remainder -= STEP }
  }
  private tick() {
    this.time += STEP
    this.impacts = this.impacts.filter(impact => this.time - impact.time < .7)
    const velocities = new Map<number, number>()
    for (const item of [...this.items]) {
      const p = item.body.translation()
      if (item.departing) {
        const t = (this.time - item.departing.at) / DEPART_SECONDS
        if (t >= 1) { this.remove(item); continue }
        const from = item.departing.from, target = CONTAINER.cloud
        const x = from[0] + (target[0] - from[0]) * t * .25
        const z = from[2] + (target[2] - from[2]) * t * .25
        item.body.setNextKinematicTranslation({ x, y: from[1] + t * 2.3 + Math.sin(t * Math.PI) * .28, z })
        continue
      }
      if (item.body.isSleeping() && this.drag?.id !== item.piece.id) continue
      const v = item.body.linvel(), mass = item.body.mass()
      velocities.set(item.collider.handle, length(v))
      // Discrete collision remains enabled for every stone. Swept CCD is needed
      // only when this step could cross a substantial fraction of its thickness;
      // tiny change, fast falls and forceful grabs retain tunnelling protection.
      const travel = (length(v) + length(item.body.angvel()) * item.radius + 19.6 * STEP) * STEP
      // A terrain triangle has no thickness. A fast downward step needs a
      // tighter threshold than a stone/stone contact, especially after another
      // falling body redirects it between two discrete terrain tests.
      const nearTerrain = p.y - item.radius < this.terrainMaximum + Math.max(.35, -v.y * STEP)
      const needsCcd = travel > item.thickness * .8 || (nearTerrain && -v.y * STEP > item.thickness * .35)
      if (item.body.isCcdEnabled() !== needsCcd) item.body.enableCcd(needsCcd)
      const wet = p.y < CONTAINER.waterY - .035
      if (wet !== item.wet) {
        if (wet && v.y < -.6) this.impact([p.x, CONTAINER.waterY, p.z], Math.min(1, -v.y / 7), item.piece.kind === 'gold', true)
        item.wet = wet
      }
      const quiet = !item.merging && this.drag?.id !== item.piece.id && this.time - item.born > .6 &&
        length(v) < .38 && length(item.body.angvel()) < 1.5
      // Extra low-energy damping suppresses resting jitter without freezing a
      // moving body. Rapier still decides sleep and wakes contacts normally.
      item.body.setLinearDamping(wet ? 2.6 : quiet ? 2.2 : .22)
      if (this.drag?.id === item.piece.id) {
        const target = this.drag.target, gain = 85, damping = 16
        const impulse = [(target[0] - p.x) * gain - v.x * damping,
          (target[1] - p.y) * gain - v.y * damping + 19.6,
          (target[2] - p.z) * gain - v.z * damping]
        const max = 110, m = Math.hypot(...impulse), cap = m > max ? max / m : 1
        item.body.applyImpulse({ x: impulse[0] * cap * mass * STEP, y: impulse[1] * cap * mass * STEP, z: impulse[2] * cap * mass * STEP }, true)
        item.body.setAngularDamping(5)
      } else if (!item.merging) {
        item.body.setAngularDamping(wet ? 3 : quiet ? 4.8 : 1.1)
      }
      // Real shore walls and CCD solve containment. Predictive protection only
      // removes a velocity that would carry the body's footprint off dry sand;
      // it never relocates a live body or supports it above the actual terrain.
      if (Math.hypot(p.x, p.z) > this.boundary.minRadius - item.radius - travel - .12) {
        const edge = this.boundary.clearance(p.x, p.z)
        const velocity = item.body.linvel(), outward = velocity.x * edge.nx + velocity.z * edge.nz
        const allowed = Math.max(0, (edge.distance - item.radius - .04) / STEP)
        if (outward > allowed + .01) {
          const excess = outward - allowed
          item.body.applyImpulse({ x: -edge.nx * excess * mass, y: 0, z: -edge.nz * excess * mass }, false)
        }
      }
    }
    for (const merge of [...this.merges]) {
      if (this.time - merge.at >= MERGE_SECONDS) {
        this.finishMerge(merge); this.merges.splice(this.merges.indexOf(merge), 1); continue
      }
      for (const id of merge.ids) {
        const item = this.items.find(item => item.piece.id === id)
        if (!item) continue
        const p = item.body.translation(), v = item.body.linvel(), mass = item.body.mass()
        item.body.applyImpulse({ x: ((merge.target[0] - p.x) * 35 - v.x * 7) * mass * STEP,
          y: ((merge.target[1] + .18 - p.y) * 35 - v.y * 7 + 19.6) * mass * STEP,
          z: ((merge.target[2] - p.z) * 35 - v.z * 7) * mass * STEP }, true)
      }
    }
    this.world.step(this.events)
    this.stabilizeTerrainContacts()
    this.events.drainCollisionEvents((a, b, started) => {
      if (!started) return
      const item = this.colliders.get(a) ?? this.colliders.get(b)
      const speed = Math.max(velocities.get(a) ?? 0, velocities.get(b) ?? 0)
      if (item && !item.departing && speed > 1.1) {
        const p = item.body.translation()
        this.impact([p.x, p.y - item.radius * .6, p.z], Math.min(1, speed / 8), item.piece.kind === 'gold')
      }
    })
    this.scheduleMerges()
  }
  /** A thin triangle surface can lose a tiny body when another contact pushes
   * it through during the solver step. Resolve only actual penetration against
   * the exported terrain's local plane with a normal impulse. This is ordinary
   * contact error correction: no added surface, relocation, suspension, or
   * sleep override. Bodies on props and upper layers take no extra impulse. */
  private stabilizeTerrainContacts() {
    for (const item of this.items) {
      if (item.departing || item.body.isSleeping()) continue
      const p = item.body.translation()
      if (p.y - item.radius > this.terrainMaximum + .02) continue
      const hit = this.terrainCollider.castRayAndGetNormal(new RAPIER.Ray({ x: p.x, y: 12, z: p.z }, { x: 0, y: -1, z: 0 }), 20, true)
      if (!hit || hit.normal.y < .3) continue
      const normal = hit.normal, ground = 12 - hit.toi
      if (p.y - ground > item.radius + .02) continue
      const q = item.body.rotation(), scale = scaleOf(item.piece), h = this.hull(this.assets[item.piece.kind])
      let support = Infinity
      let contactX = p.x, contactY = p.y, contactZ = p.z
      for (let i = 0; i < h.vertices.length; i += 3) {
        const x = h.vertices[i] * scale, y = h.vertices[i + 1] * scale, z = h.vertices[i + 2] * scale
        const cx = q.y * z - q.z * y, cy = q.z * x - q.x * z, cz = q.x * y - q.y * x
        const rx = x + 2 * (q.w * cx + q.y * cz - q.z * cy)
        const ry = y + 2 * (q.w * cy + q.z * cx - q.x * cz)
        const rz = z + 2 * (q.w * cz + q.x * cy - q.y * cx)
        const projected = rx * normal.x + ry * normal.y + rz * normal.z
        if (projected < support) {
          support = projected; contactX = p.x + rx; contactY = p.y + ry; contactZ = p.z + rz
        }
      }
      const skin = item.radius - h.radius * scale
      const planeSeparation = (p.y - ground) * normal.y + support - skin
      // The local tangent plane is conservative on broad curved slopes. Full
      // stones keep Rapier's natural contact motion unless penetration is
      // substantial; micro-fragments need the tighter small-body tolerance.
      const tolerance = item.radius < .075 ? .003 : .035
      if (planeSeparation >= -tolerance) continue
      // Confirm the candidate at its actual world-space hull vertex. A tangent
      // plane can overestimate a curved shore under a large gold; correcting
      // that approximation would keep an otherwise resting pile awake.
      const contact = this.terrainCollider.castRayAndGetNormal(new RAPIER.Ray({ x: contactX, y: 12, z: contactZ }, { x: 0, y: -1, z: 0 }), 20, true)
      if (!contact || contact.normal.y < .3) continue
      const n = contact.normal, separation = (contactY - (12 - contact.toi)) * n.y - skin
      if (separation >= -tolerance) continue
      const v = item.body.linvel(), velocity = v.x * n.x + v.y * n.y + v.z * n.z
      const target = Math.min(4, -separation * .3 / STEP)
      if (velocity < target) {
        const impulse = (target - velocity) * item.body.mass()
        item.body.applyImpulse({ x: n.x * impulse, y: n.y * impulse, z: n.z * impulse }, false)
      }
    }
  }
  get pending() { return this.time < this.actionUntil || this.merges.length > 0 || this.items.some(item => !!item.departing) }
  get isActive() { return this.pending || !!this.drag || this.items.some(item => !item.body.isSleeping()) || this.impacts.length > 0 }
  interactionState() { return { amount: this.amount, dragging: this.drag?.id ?? null } }
  metrics() {
    const retained = this.items.filter(item => !item.departing)
    return { amount: this.amount, represented: this.items.reduce((sum, item) => sum + (item.departing ? 0 : item.piece.value), 0),
      count: this.items.length, awake: this.items.filter(item => !item.departing && !item.body.isSleeping()).length,
      spent: this.items.filter(item => !!item.departing).length, dragging: this.drag?.id ?? null, pending: this.pending,
      outsideShore: retained.filter(item => { const p = item.body.translation(); return !this.boundary.contains(p.x, p.z) }).length,
      belowWater: retained.filter(item => this.lowestPoint(item) < CONTAINER.waterY - .03).length }
  }
  private lowestPoint(item: Item) {
    const p = item.body.translation()
    if (p.y - item.radius >= CONTAINER.waterY) return p.y - item.radius
    const q = item.body.rotation(), scale = scaleOf(item.piece), vertices = this.assets[item.piece.kind].vertices
    let bottom = Infinity
    for (let i = 0; i < vertices.length; i += 3) {
      const x = vertices[i] * scale, y = vertices[i + 1] * scale, z = vertices[i + 2] * scale
      const cx = q.y * z - q.z * y, cy = q.z * x - q.x * z, cz = q.x * y - q.y * x
      bottom = Math.min(bottom, p.y + y + 2 * (q.w * cy + q.z * cx - q.x * cz))
    }
    return bottom
  }
  private assertValue() {
    if (this.items.reduce((sum, item) => sum + (item.departing ? 0 : item.piece.value), 0) !== this.amount) throw new Error('Physical reserve lost committed value')
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true; this.events.free(); this.world.free(); this.items = []; this.colliders.clear()
  }
}
