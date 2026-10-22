import RAPIER from '@dimforge/rapier3d-compat'
import { GOLD, STONE } from '../domain/reserve.ts'
import { SMALL_SCALE, ground, splash, sideSandPosition, goldPosition, type MotionPlan, type Piece, type Vec3 } from './reserveMotion.ts'

// One shared WASM initialization; the surrounding Suspense/error boundary owns failure.
export const physicsReady = RAPIER.init()
export const PHYSICS_SECONDS = 1.8
export const INCOME_COMPLETE_AT = .7
export const EXPENSE_DEPART_AT = .34
const GRAVITY = 24
const FRACTURE_AT = .12
const CONVERSION_SECONDS = .16
const STEP = 1 / 90
export interface Shape { vertices: Float32Array; centerY: number }
export interface PhysicsAssets { sand: Shape; gold: Shape; terrain: { vertices: Float32Array; indices: Uint32Array } }
interface Body { previous?: Piece; body: RAPIER.RigidBody; piece: Piece; source?: Piece; spent?: boolean; launchAt?: number; lifted?: boolean; launched?: boolean; born: number }
export interface Impact { position: Vec3; time: number; strength: number; water?: boolean; gold?: boolean; effect?: 'merge' | 'fracture' }
const noise = (i: number) => { const n = Math.sin(i * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n) }
interface Hull {
  vertices: Float32Array; indices: Uint32Array
  mass: number; center: RAPIER.Vector; inertia: RAPIER.Vector; frame: RAPIER.Rotation; radius: number
}
const hulls = new WeakMap<Shape, Hull>()
const size = (p: Piece) => SMALL_SCALE * Math.cbrt(p.value / (p.kind === 'gold' ? GOLD : STONE))
interface Bounds { min: Vec3; max: Vec3 }
function pieceBounds(piece: Piece, shape: Shape): Bounds {
  const scale = size(piece), q = piece.orientation ?? [0, Math.sin(piece.rotation / 2), 0, Math.cos(piece.rotation / 2)]
  const position = [...piece.position] as Vec3
  if (!piece.centered) position[1] += shape.centerY * scale
  const bounds: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
  const vertices = hulls.get(shape)?.vertices ?? shape.vertices
  for (let i = 0; i < vertices.length; i += 3) {
    const x = vertices[i] * scale, y = vertices[i + 1] * scale, z = vertices[i + 2] * scale
    const cx = q[1] * z - q[2] * y, cy = q[2] * x - q[0] * z, cz = q[0] * y - q[1] * x
    const point = [x + 2 * (q[3] * cx + q[1] * cz - q[2] * cy),
      y + 2 * (q[3] * cy + q[2] * cx - q[0] * cz),
      z + 2 * (q[3] * cz + q[0] * cy - q[1] * cx)]
    for (let axis = 0; axis < 3; axis++) {
      bounds.min[axis] = Math.min(bounds.min[axis], point[axis] + position[axis])
      bounds.max[axis] = Math.max(bounds.max[axis], point[axis] + position[axis])
    }
  }
  return bounds
}
const overlaps = (a: Bounds, b: Bounds) => a.min.every((min, axis) => min < b.max[axis] + .008 && a.max[axis] > b.min[axis] - .008)

/** Fixed-step convex rigid bodies. Only attraction/transmutation and the spending
 * launch are authored; gravity, contacts, rotation, friction and rest are solved. */
export class ReservePhysics {
  world: RAPIER.World
  assets: PhysicsAssets
  plan: MotionPlan | null = null
  bodies: Body[] = []
  impacts: Impact[] = []
  time = 0
  private remainder = 0
  private spawned = new Set<number>()
  private converted = false
  private departed = false
  private ghost: Piece[] = []
  private gatherHeight = ground + 1
  constructor(assets: PhysicsAssets, initial: Piece[], plan: MotionPlan | null = null) {
    this.assets = assets
    this.world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 })
    this.world.timestep = STEP
    this.world.numSolverIterations = 8
    this.world.createCollider(RAPIER.ColliderDesc.trimesh(assets.terrain.vertices, assets.terrain.indices).setFriction(.95).setRestitution(.03))
    this.reset(initial, plan)
  }
  /** Keep the terrain broad phase and WASM world across ledger operations. */
  reset(initial: Piece[], plan: MotionPlan | null = null) {
    for (const item of this.bodies) this.world.removeRigidBody(item.body)
    this.bodies = []; this.impacts = []; this.ghost = []
    this.plan = plan; this.time = 0; this.remainder = 0
    this.spawned.clear(); this.converted = false; this.departed = false
    // Unchanged, settled gold remains an exact stationary collision obstacle.
    // A small transaction must not wake and resimulate the entire old stack.
    const start = plan ? [...plan.fixed, ...plan.brokenGold, ...plan.spendingGold, ...plan.looseBefore] : initial
    const gold = initial.filter(p => p.kind === 'gold'), sand = initial.filter(p => p.kind === 'sand').sort((a, b) => a.value - b.value)
    if (plan?.transaction.type === 'expense') {
      const spending = [...gold].sort((a, b) => b.position[1] - a.position[1] || (b.position[0] + b.position[2]) - (a.position[0] + a.position[2])).slice(0, plan.spendingGold.length)
      for (const piece of spending) gold.splice(gold.indexOf(piece), 1)
      gold.push(...spending)
    }
    if (plan?.brokenGold.length) {
      const accessible = (p: Piece) => p.position[0] ** 2 + (p.position[2] - .65) ** 2 - p.position[1] * 3
      const nearest = gold.reduce((best, p, i) => accessible(p) < accessible(gold[best]) ? i : best, 0)
      const [opening] = gold.splice(nearest, 1)
      gold.splice(plan.fixed.length, 0, opening)
    }
    let gi = 0, si = 0
    for (const source of start) {
      const pose = (source.kind === 'gold' ? gold[gi++] : sand[si++]) ?? source
      const item = this.add({ ...pose, value: source.value }, source)
      if (plan?.fixed.includes(source)) item.body.setBodyType(RAPIER.RigidBodyType.Fixed, false)
    }
    this.gatherHeight = this.bodies.reduce((height, item) => item.source && plan?.fixed.includes(item.source)
      ? Math.max(height, item.body.translation().y + hulls.get(this.assets[item.piece.kind])!.radius * size(item.piece) + .45)
      : height, ground + 1)
    if (plan?.transaction.type === 'income') {
      // Spending can leave a gold piece in any settled slot, not necessarily
      // the first N canonical slots. Reserve each new slot against the actual
      // rotated hull bounds and all earlier new targets before dropping it.
      const occupied = this.bodies.filter(item => item.source && plan.fixed.includes(item.source))
        .map(item => pieceBounds(this.pose(item), this.assets.gold))
      for (const piece of plan.targets) {
        if (piece.kind !== 'gold') continue
        let bounds = pieceBounds(piece, this.assets.gold)
        if (occupied.some(other => overlaps(bounds, other))) {
          for (let slot = 0; slot < 48; slot++) {
            const candidate = { ...piece, position: goldPosition(slot) }
            const candidateBounds = pieceBounds(candidate, this.assets.gold)
            if (occupied.some(other => overlaps(candidateBounds, other))) continue
            piece.position = candidate.position; bounds = candidateBounds; break
          }
        }
        occupied.push(bounds)
      }
    }
  }
  private add(piece: Piece, source?: Piece): Body {
    const scale = size(piece), shape = this.assets[piece.kind]
    const position = [...piece.position] as Vec3
    if (!piece.centered) position[1] += shape.centerY * scale
    const orientation = piece.orientation ?? [0, Math.sin(piece.rotation / 2), 0, Math.cos(piece.rotation / 2)]
    let cached = hulls.get(shape)
    if (!cached) {
      // Computing an irregular hull's inertia directly at a one-cent scale
      // loses precision in Rapier 0.12 (including zero principal axes).
      // Compute once in model space, then apply the exact scaling laws.
      const probe = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic())
      const hull = RAPIER.ColliderDesc.convexHull(shape.vertices)
      if (!hull) { this.world.removeRigidBody(probe); throw new Error('Invalid reserve convex hull') }
      const collider = this.world.createCollider(hull.setDensity(2.4), probe)
      const indices = collider.indices()
      if (!indices) { this.world.removeRigidBody(probe); throw new Error('Missing reserve convex hull faces') }
      const hullVertices = new Float32Array(collider.vertices())
      let radius = 0
      for (let i = 0; i < hullVertices.length; i += 3) radius = Math.max(radius, Math.hypot(hullVertices[i], hullVertices[i + 1], hullVertices[i + 2]))
      cached = { vertices: hullVertices, indices: new Uint32Array(indices), radius,
        mass: probe.mass(), center: probe.localCom(), inertia: probe.principalInertia(), frame: probe.principalInertiaLocalFrame() }
      hulls.set(shape, cached)
      this.world.removeRigidBody(probe)
    }
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(...position).setRotation({ x: orientation[0], y: orientation[1], z: orientation[2], w: orientation[3] })
      .setLinearDamping(.1).setAngularDamping(1.4).setCcdEnabled(true))
    const vertices = Float32Array.from(cached.vertices, n => n * scale)
    const collider = RAPIER.ColliderDesc.convexMesh(vertices, cached.indices)
    if (!collider) { this.world.removeRigidBody(body); throw new Error('Invalid reserve convex hull') }
    // Equal represented volume has equal mass; gold feels ten times as heavy.
    const inertiaScale = scale ** 5
    this.world.createCollider(collider.setMassProperties(cached.mass * scale ** 3,
      { x: cached.center.x * scale, y: cached.center.y * scale, z: cached.center.z * scale },
      { x: cached.inertia.x * inertiaScale, y: cached.inertia.y * inertiaScale, z: cached.inertia.z * inertiaScale },
      cached.frame).setFriction(.9).setRestitution(.10), body)
    const item = { body, piece: { ...piece, factor: 1, centered: true }, source, born: this.time }
    this.bodies.push(item)
    return item
  }
  private remove(item: Body) {
    this.world.removeRigidBody(item.body)
    this.bodies.splice(this.bodies.indexOf(item), 1)
  }
  private pose(item: Body): Piece {
    const p = item.body.translation(), q = item.body.rotation()
    return { ...item.piece, position: [p.x, p.y, p.z], orientation: [q.x, q.y, q.z, q.w] }
  }
  private impact(position: Vec3, strength: number, gold = false, water = false, effect?: Impact['effect']) {
    this.impacts.push({ position, time: this.time, strength, gold, water, effect })
    if (this.impacts.length > 60) this.impacts.shift()
  }
  advance(delta: number) {
    this.remainder += Math.min(delta, .1)
    while (this.remainder >= STEP && this.time < PHYSICS_SECONDS) { this.tick(); this.remainder -= STEP }
  }
  private tick() {
    for (const item of this.bodies) item.previous = this.pose(item)
    this.time += STEP
    const plan = this.plan, t = this.time
    if (plan?.transaction.type === 'income') {
      plan.incoming.forEach((piece, i) => {
        const at = .025 + i / Math.max(1, plan.incoming.length) * .16
        if (t < at || this.spawned.has(i)) return
        this.spawned.add(i)
        const destination = plan.fragments.find(f => f.source === piece)?.target ?? piece
        const many = plan.bulkIncome
        // Land in the destination's free cell. Routing an income's sandstone
        // to the side bank first would then pull it horizontally through the
        // existing gold stack when it combines, pushing that stack off-shore.
        const target = destination.position
        const p: Vec3 = many
          ? [target[0], target[1] + this.assets[piece.kind].centerY * size(piece) + (piece.kind === 'sand' ? .45 : .1), target[2]]
          : [(plan.transaction.after >= 2 * GOLD ? .6 : 2.7) + i % 2 * .18, 1.15, 3.25 + i % 3 * .10]
        const item = this.add({ ...piece, position: p, centered: true }, piece)
        const flight = .36
        item.body.setLinvel(many ? { x: 0, y: -.3, z: 0 } :
          { x: (target[0] - p[0]) / flight, y: (target[1] + this.assets[piece.kind].centerY * size(piece) - p[1] + (GRAVITY / 2) * flight ** 2) / flight, z: (target[2] - p[2]) / flight }, true)
        item.body.setAngvel(many ? { x: .12, y: .08, z: -.1 } : { x: 3 + noise(i) * 3, y: noise(i + 1) * 4 - 2, z: 2 + noise(i + 2) * 3 }, true)
      })
      if (plan.bulkIncome && t < .55) for (const item of this.bodies) {
        const index = item.source ? plan.looseBefore.indexOf(item.source) : -1
        if (index < 0) continue
        const target = sideSandPosition(index), p = item.body.translation(), v = item.body.linvel(), m = item.body.mass()
        item.body.applyImpulse({ x: ((target[0] - p.x) * 26 - v.x * 8) * m * STEP, y: 0, z: ((target[2] - p.z) * 26 - v.z * 8) * m * STEP }, true)
      }
      if (t > .2 && t < INCOME_COMPLETE_AT) for (const item of this.bodies) {
        if (!item.source || plan.fixed.includes(item.source)) continue
        if (plan.bulkIncome && item.piece.kind === 'gold') continue
        const target = plan.fragments.find(f => f.source === item.source)?.target
        if (!target) continue
        const p = item.body.translation(), v = item.body.linvel()
        const force = Math.min(1, (t - .2) / .12)
        const m = item.body.mass()
        // Existing loose stones rise above the fixed pile before converging.
        // A horizontal pull through the pile transfers enough force to shove
        // old gold off the island; this authored transmutation must route over it.
        const lift = target.kind === 'gold' && plan.fixed.length > 0
        const lateral = lift ? Math.max(0, Math.min(1, (p.y - this.gatherHeight + .12) / .12)) : 1
        item.body.applyImpulse({ x: ((target.position[0] - p.x) * 75 * lateral - v.x * 13) * m * STEP * force,
          y: lift ? ((this.gatherHeight - p.y) * 100 - v.y * 18 + GRAVITY) * m * STEP * force : 0,
          z: ((target.position[2] - p.z) * 75 * lateral - v.z * 13) * m * STEP * force }, true)
        item.body.setAngularDamping(1.8)
      }
      if (t >= INCOME_COMPLETE_AT && !this.converted) {
        this.converted = true
        for (const item of [...this.bodies]) if (item.source && !plan.fixed.includes(item.source)) {
          this.ghost.push(this.pose(item)); this.remove(item)
        }
        for (const [i, piece] of plan.targets.entries()) {
          const landingLift = plan.bulkIncome || piece.position[1] > ground + .2 ? .015 : .09
          const item = this.add({ ...piece, position: [piece.position[0], piece.position[1] + landingLift, piece.position[2]] })
          if (!plan.bulkIncome) item.body.setAngvel({ x: .35, y: .15, z: -.3 }, true)
          if (i < 24) this.impact(piece.position, piece.kind === 'gold' ? 1 : .35, piece.kind === 'gold', false, piece.kind === 'gold' ? 'merge' : undefined)
        }
      }
    } else if (plan) {
      const departureAt = plan.brokenGold.length ? EXPENSE_DEPART_AT : .035
      // Whole denominations leave first, before a neighbouring gold splits
      // into change. Their lift clears the fracture area without sweeping
      // newly released sandstone sideways.
      for (const item of this.bodies) {
        const index = item.source ? plan.spendingGold.indexOf(item.source) : -1
        if (index < 0 || item.spent) continue
        item.spent = true; item.launchAt = .025 + index / Math.max(1, plan.spendingGold.length) * .04
      }
      if (t < FRACTURE_AT) for (const item of this.bodies) if (item.source && plan.brokenGold.includes(item.source)) {
        // Short torque pulses before release, with contact maintained.
        item.body.applyTorqueImpulse({ x: 0, y: Math.sin(t * 65) * .00045, z: Math.sin(t * 47) * .00035 }, true)
      }
      if (t >= FRACTURE_AT && !this.converted) {
        this.converted = true
        const origins = plan.brokenGold.map(source => {
          const item = this.bodies.find(b => b.source === source)!
          const pose = this.pose(item); this.remove(item)
          this.impact(pose.position, 1, true, false, 'fracture')
          return pose
        })
        plan.released.forEach((piece, i) => {
          const origin = origins[Math.floor(i / 10)], j = i % 10
          // Non-overlapping fracture pieces: solver depenetration must not add
          // an accidental explosive impulse on top of the authored release.
          const dx = (j % 3 - 1) * .40, dz = (Math.floor(j / 3) % 2 - .5) * .39
          const dy = (Math.floor(j / 6) - .5) * .36
          const p: Vec3 = [origin.position[0] + dx, origin.position[1] + dy + .08, origin.position[2] + dz]
          const item = this.add({ ...piece, position: p, centered: true, orientation: [0, 0, 0, 1] }, piece)
          item.body.setLinvel({ x: dx * 1.1 + (noise(i) - .5) * .25, y: .8 + noise(i + 4) * .25, z: dz * 1.1 }, true)
          item.body.setAngvel({ x: (noise(i + 2) - .5) * 3, y: noise(i + 8) * 2, z: (noise(i + 3) - .5) * 3 }, true)
        })
      }
      if (t >= departureAt && !this.departed) {
        this.departed = true
        const sources = new Map(this.bodies.filter(b => b.source && plan.pool.includes(b.source)).map(b => [b.source!, b]))
        const spent = plan.fragments.filter(f => !f.target)
        plan.fragments.forEach(fragment => {
          const item = sources.get(fragment.source)!
          // Unsplit retained pieces keep their exact physical pose and momentum.
          if (fragment.value === item.piece.value) {
            if (!fragment.target) { item.spent = true; item.launchAt = departureAt + .015 + spent.indexOf(fragment) / Math.max(1, spent.length) * .1 }
            return
          }
          const pose = this.pose(item), vel = item.body.linvel()
          // Split pieces must not overlap: the old +/-8cm offset intersected
          // both children and adjacent stones, injecting a solver explosion.
          // Keep the retained child inside its parent's footprint; lift the
          // departing child by the two rotation-independent support radii.
          const childPiece = { ...pose, value: fragment.value }
          const otherPiece = { ...pose, value: pose.value - fragment.value }
          const lift = fragment.target ? 0 : hulls.get(this.assets[pose.kind])!.radius * (size(childPiece) + size(otherPiece)) + .015
          const child = this.add({ ...childPiece, position: [pose.position[0], pose.position[1] + lift, pose.position[2]] })
          child.body.setLinvel(vel, true)
          if (!fragment.target) { child.spent = true; child.launchAt = departureAt + .015 + spent.indexOf(fragment) / Math.max(1, spent.length) * .1 }
        })
        for (const [source, item] of sources) if (plan.fragments.filter(f => f.source === source).length > 1) this.remove(item)
      }
      for (const item of [...this.bodies]) {
        if (!item.spent) continue
        if (!item.launched && t >= item.launchAt!) {
          if (!item.lifted) {
            item.lifted = true; item.launchAt = t + .12
            item.body.setLinearDamping(0); item.body.setLinvel({ x: 0, y: 8, z: 0 }, true)
            continue
          }
          item.launched = true
          const p = item.body.translation(), flight = .43
          // One impulse, followed by free flight; no lerp along a decorative arc.
          item.body.setLinearDamping(0)
          item.body.setLinvel({ x: (splash[0] - p.x) / flight, y: (.05 - p.y + (GRAVITY / 2) * flight ** 2) / flight, z: (splash[2] - p.z) / flight }, true)
          item.body.setAngvel({ x: 4, y: 2, z: 5 }, true)
        }
        if (item.launched) {
          const p = item.body.translation()
          if (p.y < .08 || t > 1.25) { this.impact([p.x, .09, p.z], .7, false, true); this.remove(item) }
        }
      }
    }
    const velocities = this.bodies.map(item => item.body.linvel().y)
    // One-cent fragments are only centimetres wide. Tighten contact/CCD
    // precision while they exist so departing gold cannot squeeze them through
    // the thin terrain triangles. Ordinary piles keep their original budget.
    const tiny = this.bodies.some(item => item.piece.value < 100)
    this.world.integrationParameters.allowedLinearError = tiny ? .0001 : .001
    this.world.integrationParameters.maxCcdSubsteps = tiny ? 4 : 1
    this.world.step()
    this.bodies.forEach((item, i) => {
      const v = item.body.linvel(), p = item.body.translation()
      if (velocities[i] < -.8 && v.y - velocities[i] > .7 && t - item.born > .06) {
        this.impact([p.x, p.y - this.assets[item.piece.kind].centerY * size(item.piece), p.z], Math.min(1, -velocities[i] / 4), item.piece.kind === 'gold')
      }
      // Dissipate energy after contacts. Rest is solved, never snapped to a grid.
      if (p.y < 1.15 && !item.launched && !item.lifted && t > .65) { item.body.setLinearDamping(1.6); item.body.setAngularDamping(3.5) }
      if (t > .85 && !item.launched && !item.lifted) { item.body.setLinearDamping(8); item.body.setAngularDamping(12) }
    })
    this.impacts = this.impacts.filter(impact => t - impact.time < .55)
  }
  pieces(interpolate = false): Piece[] {
    const alpha = interpolate && this.time < PHYSICS_SECONDS ? this.remainder / STEP : 1
    const pieces = this.bodies.map(item => {
      const current = this.pose(item), previous = item.previous
      if (!previous || alpha >= 1) return current
      current.position = current.position.map((n, i) => previous.position[i] + (n - previous.position[i]) * alpha) as Vec3
      const a = previous.orientation!, b = current.orientation!
      const sign = a.reduce((n, v, i) => n + v * b[i], 0) < 0 ? -1 : 1
      const q = a.map((v, i) => v + (b[i] * sign - v) * alpha)
      const length = Math.hypot(...q)
      current.orientation = q.map(v => v / length) as [number, number, number, number]
      return current
    })
    if (this.plan?.transaction.type === 'expense' && this.time < FRACTURE_AT) {
      pieces.forEach((piece, i) => { if (this.bodies[i].source && this.plan!.brokenGold.includes(this.bodies[i].source!)) piece.crack = Math.max(0, this.time / FRACTURE_AT) })
    }
    if (this.plan?.transaction.type === 'income' && this.converted && this.time < INCOME_COMPLETE_AT + CONVERSION_SECONDS) {
      const linear = Math.max(0, Math.min(1, (this.time - INCOME_COMPLETE_AT) / CONVERSION_SECONDS))
      const p = linear * linear * (3 - 2 * linear)
      for (let i = 0; i < pieces.length; i++) if (!this.bodies[i].source) pieces[i].factor = p
      pieces.push(...this.ghost.map(piece => ({ ...piece, factor: 1 - p })))
    }
    return pieces
  }
  phase() {
    if (!this.plan) return '储备已归位'
    if (this.plan.transaction.type === 'income') return this.time < .42 ? '砂岩到岸 · 落地碰撞' : this.time < .88 ? (this.plan.addedGold.length ? '砂岩聚拢 · 合成金矿' : '整理小砂岩') : '矿石落定'
    return this.time < EXPENSE_DEPART_AT ? (this.plan.brokenGold.length ? '金矿裂开 · 碰撞散落' : '取出散落砂岩') : this.time < 1.1 ? '支出离岛 · 剩余砂岩归位' : '储备已归位'
  }
  dispose() { this.world.free() }
}
