import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { FreeReservePhysics, physicsReady } from '../src/scene/FreeReservePhysics.ts'
import { CONTAINER } from '../src/scene/containerConfig.ts'
import { GOLD, STONE, STONES_PER_GOLD, DEMO_LIMIT } from '../src/domain/reserve.ts'
import { freePhysicsFixture, physicsAssetHashes } from './physics-fixture.mjs'
import { createShoreBoundary } from '../src/scene/shoreBoundary.ts'

await physicsReady
assert.equal(GOLD, STONE * STONES_PER_GOLD, 'Gold uses the shared sandstone denomination')
assert.equal(STONES_PER_GOLD, 200)
const assets = await freePhysicsFixture()
const assetHashes = await physicsAssetHashes()
assert.equal(assets.collisionProxy.sourceSha256, assetHashes['island-study.glb'], 'Baked contact geometry belongs to the exact displayed island')
assert.ok(assets.collisionProxy.diagnostics.maximumTerrainHeightError <= .005, 'Independently sampled dry surface differs by at most 5mm')
assert.ok(assets.collisionProxy.diagnostics.maximumObstacleSurfaceError <= .005, 'Bidirectional sampled fixed-prop surfaces differ by at most 5mm')
assert.ok(assets.collisionProxy.diagnostics.terrainHeightSamples > 80000, 'Terrain validation covers source vertices, edges, centers and a 6cm dry grid')
assert.ok(assets.collisionProxy.diagnostics.obstacleSurfaceSamples > 200000, 'Changed fixed props retain independently validated physical surfaces')
const boundary = createShoreBoundary(assets.terrain)
assert.ok(boundary.points.flat().every(Number.isFinite), 'Actual terrain produces a complete finite dry shore contour')
assert.ok(boundary.maxRadius - boundary.minRadius > .25, 'The playable shore follows the irregular island instead of a circular water boundary')
assert.ok(CONTAINER.waterRadius > boundary.maxRadius, 'Decorative deep water lies beyond the dry shore')
for (let i = 0; i < 128; i++) {
  const angle = i / 128 * Math.PI * 2
  for (const radius of [.02, .23, .6]) {
    const point = boundary.project(Math.cos(angle) * 30, Math.sin(angle) * 30, radius)
    assert.ok(boundary.contains(...point, radius - 1e-5), 'Every direction projects inside the actual per-piece inset contour')
  }
}
const report = []
let serial = 0
const commit = (sim, type, amount) => {
  const before = sim.metrics().amount
  const transaction = { id: `free-test-${++serial}`, type, amount, before, after: before + (type === 'income' ? amount : -amount) }
  sim.commit(transaction)
  assert.equal(sim.metrics().represented, transaction.after, 'Every committed amount is immediately represented exactly')
  return transaction
}
const step = (sim, seconds, expected = sim.metrics().amount) => {
  for (let i = 0; i < seconds * 60; i++) {
    sim.advance(1 / 60)
    const metrics = sim.metrics()
    assert.equal(metrics.represented, expected, 'Merges and split/spend preserve every committed fen at every fixed step')
    assert.ok(metrics.count <= 420, `Bounded physical population: ${metrics.count}`)
    assert.equal(metrics.outsideShore, 0, 'Retained value remains inside the actual dry shore outline')
    assert.equal(metrics.belowWater, 0, 'Every rotated exported stone stays visible above water; no deep-water relocation or hidden reserve')
    for (const piece of sim.pieces()) {
      assert.ok([...piece.position, ...piece.orientation].every(Number.isFinite), 'Finite body position and rotation')
      if (!piece.spent) {
        assert.ok(boundary.contains(piece.position[0], piece.position[2]), 'Retained value stays within terrain-derived contour')
        assert.ok(piece.position[1] > CONTAINER.waterY, `Stone stays above real dry sand: ${piece.position}`)
      }
    }
  }
}

// Stable object identity and actual terrain support survive consecutive actions.
{
  const sim = new FreeReservePhysics(assets, STONE * 8)
  const initial = sim.pieces()
  assert.ok(initial.every(piece => piece.position[1] > sim.terrainHeight(piece.position[0], piece.position[2])), 'Initial stones sit on the exported island, not on a fake water plane')
  const income = commit(sim, 'income', STONE * 2)
  const incoming = sim.pieces().filter(piece => !initial.some(old => old.id === piece.id))
  assert.equal(incoming.length, 2)
  assert.ok(incoming.every(piece => piece.position[1] < CONTAINER.cloud[1] && piece.position[1] > CONTAINER.cloud[1] - 1.8), 'Income starts beneath the raised thin cloud')
  step(sim, .12)
  assert.ok(sim.pieces().find(piece => piece.id === incoming[0].id).position[1] < incoming[0].position[1] - .2, 'Income falls immediately')
  assert.ok(initial.every(piece => sim.pieces().some(current => current.id === piece.id)), 'New income preserves old object ids')
  const beforeDuplicate = sim.metrics().represented
  sim.commit(income)
  assert.equal(sim.metrics().represented, beforeDuplicate, 'Repeated receipt id never duplicates money')
  commit(sim, 'expense', STONE)
  step(sim, .06)
  commit(sim, 'expense', STONE)
  assert.equal(sim.metrics().spent, 2, 'Second expense overlaps the first outgoing flight')
  step(sim, 6)
  report.push({ case: 'concurrent-income-expense', ...sim.metrics() })
  sim.dispose()
}

// A complete denomination gathers only after its last stone arrives.
{
  const sim = new FreeReservePhysics(assets, (STONES_PER_GOLD - 1) * STONE)
  assert.equal(sim.metrics().count, STONES_PER_GOLD - 1)
  commit(sim, 'income', STONE)
  assert.equal(sim.pieces().filter(piece => piece.kind === 'gold').length, 0, 'The final stone is not compacted immediately at commit')
  step(sim, 2)
  assert.equal(sim.pieces().filter(piece => piece.kind === 'gold').length, 1, 'The two-hundredth sandstone creates one gold')
  assert.equal(sim.metrics().count, 1)
  const goldId = sim.pieces()[0].id
  sim.sync(GOLD)
  assert.equal(sim.pieces()[0].id, goldId, 'Same-balance skip keeps existing gold pose and identity')
  commit(sim, 'expense', 1)
  assert.equal(sim.metrics().represented, GOLD - 1)
  const change = sim.pieces().filter(piece => piece.kind === 'sand' && !piece.spent)
  assert.equal(change.filter(piece => piece.value === STONE).length, STONES_PER_GOLD - 1, 'A one-fen gold expense leaves 199 whole stones')
  assert.equal(change.filter(piece => piece.value === STONE - 1).length, 1, 'The last fractional change remains an independently represented stone')
  step(sim, 5)
  report.push({ case: '199-plus-one-and-199-stones-fractional-change', ...sim.metrics() })
  sim.dispose()
}

// Repeated opposing entries near the full reserve remain available during
// split/departure/merge animations, including at the exact maximum balance.
{
  const sim = new FreeReservePhysics(assets, DEMO_LIMIT)
  let maxCount = sim.metrics().count
  for (let i = 0; i < 24; i++) {
    commit(sim, 'expense', i % 2 ? STONE : 1)
    step(sim, .05)
    commit(sim, 'income', i % 2 ? STONE : 1)
    step(sim, .05)
    maxCount = Math.max(maxCount, sim.metrics().count)
  }
  step(sim, 8)
  assert.equal(sim.metrics().amount, DEMO_LIMIT)
  assert.equal(sim.pieces().filter(piece => piece.kind === 'gold').length, DEMO_LIMIT / GOLD)
  assert.equal(sim.metrics().spent, 0, 'All overlapping withdrawals finish without retaining spent value')
  report.push({ case: 'continuous-opposing-entries-at-million-boundary', maxCount, ...sim.metrics() })
  sim.dispose()
}

// Two large deposits can overlap an active gather near the maximum balance.
{
  const sim = new FreeReservePhysics(assets, DEMO_LIMIT - 2 * GOLD)
  commit(sim, 'income', GOLD)
  // Synchronize this stress input to the short gathering window rather than
  // relying on a frame-time guess or changing the motion to make a test pass.
  for (let i = 0; i < 180 && !sim.merges.length; i++) step(sim, 1 / 60)
  assert.ok(sim.merges.length, 'The first 200-stone deposit begins its actual gather')
  commit(sim, 'income', GOLD - STONE)
  assert.ok(sim.metrics().count <= 420, 'A second deposit during gathering cannot overflow the physical/render population')
  step(sim, 6)
  assert.equal(sim.metrics().represented, DEMO_LIMIT - STONE)
  assert.equal(sim.pieces().filter(piece => piece.kind === 'gold').length, DEMO_LIMIT / GOLD - 1)
  assert.equal(sim.pieces().filter(piece => piece.kind === 'sand').length, STONES_PER_GOLD - 1)
  report.push({ case: 'large-deposit-during-active-gather', ...sim.metrics() })
  sim.dispose()
}

// Grab is a spring acting on a dynamic collider, then release back to gravity.
{
  const sim = new FreeReservePhysics(assets, STONE * 4)
  const target = sim.pieces()[0]
  assert.equal(sim.startDrag(target.id, [target.position[0], 3, target.position[2]]), true)
  step(sim, .8)
  const lifted = sim.pieces().find(piece => piece.id === target.id)
  assert.ok(lifted.position[1] > target.position[1] + 1, 'Pointer grab physically lifts the selected body')
  sim.moveDrag([40, 3, 0])
  step(sim, .9)
  sim.endDrag()
  step(sim, 4)
  const edge = sim.pieces().find(piece => piece.id === target.id)
  assert.ok(edge.position[1] < Math.max(1, sim.footprintHeight(edge.position[0], edge.position[2], .27) + .5) &&
    edge.position[1] > CONTAINER.waterY, 'Released edge stone rests on visible dry sand or an actual shore boulder')
  assert.ok(boundary.contains(edge.position[0], edge.position[2]), 'Edge release follows the terrain contour')
  assert.equal(sim.startDrag(target.id, [edge.position[0], edge.position[1] + 1, edge.position[2]]), true, 'The same edge stone remains independently grabbable')
  step(sim, .7)
  assert.ok(sim.pieces().find(piece => piece.id === target.id).position[1] > edge.position[1] + .5, 'Edge re-grab lifts the same live dynamic body')
  sim.endDrag()
  assert.equal(sim.metrics().represented, STONE * 4, 'Playing with a stone never changes ledger value')
  sim.nudge([.9, .2])
  assert.ok(sim.metrics().awake > 0, 'Orbit gesture wakes sleeping dynamic bodies')
  step(sim, 8)
  report.push({ case: 'drag-release-dry-shore-regrab', ...sim.metrics() })
  sim.dispose()
}

// The stone contacts actual GLB props, plus another dynamic stone.
{
  const sim = new FreeReservePhysics(assets, STONE)
  const initial = sim.pieces()[0], id = initial.id
  const roof = [-2.75, 2.58, -1.5]
  assert.equal(sim.startDrag(id, [initial.position[0], 3.8, initial.position[2]]), true)
  step(sim, 1.4)
  sim.moveDrag([roof[0], 3.8, roof[2]])
  step(sim, 2)
  sim.endDrag()
  step(sim, .4)
  const piece = sim.pieces().find(piece => piece.id === id)
  assert.ok(piece.position[1] > 2.45, 'A falling stone lands on the actual exported house roof instead of passing through it')
  report.push({ case: 'actual-house-roof-contact', landedHeight: piece.position[1], ...sim.metrics() })
  sim.dispose()
}
{
  const sim = new FreeReservePhysics(assets, 0)
  commit(sim, 'income', STONE * 12)
  step(sim, 1.2)
  assert.ok(sim.impacts.length > 0, 'Real exported colliders produce contact feedback')
  // The higher cloud adds impact energy and can send stones into the shallow
  // edge. Allow their real rolling motion to settle without changing damping.
  step(sim, 19)
  assert.ok(sim.metrics().awake <= 2, 'Low-energy bodies settle through native Rapier sleep')
  report.push({ case: 'natural-sleep', ...sim.metrics() })
  sim.dispose()
}
{
  const sim = new FreeReservePhysics(assets, 0)
  commit(sim, 'income', GOLD)
  assert.equal(sim.metrics().count, STONES_PER_GOLD, 'A full ordinary deposit really creates 200 stones before gathering')
  assert.ok(sim.pieces().every(piece => piece.position[1] < CONTAINER.cloud[1]), 'All drop layers stay below the cloud')
  step(sim, .5)
  assert.equal(sim.pieces().filter(piece => piece.kind === 'gold').length, 0, 'The raised-cloud deposit does not merge in mid-air')
  step(sim, 1.5)
  const gold = sim.pieces().find(piece => piece.kind === 'gold')
  assert.ok(gold && gold.position[1] < 2.5, 'The full deposit reaches the island before completing its merge')
  report.push({ case: 'raised-cloud-and-terrain-derived-shore', shoreMinimumRadius: boundary.minRadius, shoreMaximumRadius: boundary.maxRadius, waterRadius: CONTAINER.waterRadius, ...sim.metrics() })
  sim.dispose()
}

// Real transaction interleaving, tiny change, and large transfers are all exact.
{
  const sim = new FreeReservePhysics(assets, 0)
  let maxCount = 0
  for (let i = 0; i < 120; i++) {
    commit(sim, 'income', i % 3 === 0 ? STONE * 2 : 1)
    if (i % 4 === 0) commit(sim, 'expense', 1)
    step(sim, .05)
    maxCount = Math.max(maxCount, sim.metrics().count)
  }
  step(sim, 5)
  commit(sim, 'income', DEMO_LIMIT - sim.metrics().amount)
  step(sim, 8)
  commit(sim, 'expense', DEMO_LIMIT - 1)
  step(sim, 8)
  assert.equal(sim.metrics().represented, 1, 'Huge withdrawal leaves a real one-fen change body')
  report.push({ case: 'burst-large-transfer-tiny-change', maxCount, ...sim.metrics() })
  sim.dispose()
}
{
  const sim = new FreeReservePhysics(assets, STONE * 10)
  let maxCount = 0
  for (let i = 0; i < 600; i++) {
    commit(sim, 'income', 1)
    maxCount = Math.max(maxCount, sim.metrics().count)
  }
  assert.ok(maxCount <= 50, 'Hundreds of fractional clicks cannot create an unbounded fragment population')
  step(sim, 4)
  report.push({ case: 'fractional-click-storm', maxCount, ...sim.metrics() })
  sim.dispose()
}
{
  const sim = new FreeReservePhysics(assets, STONE, true)
  commit(sim, 'income', GOLD)
  assert.equal(sim.pending, false, 'Reduced motion immediately renders the committed state')
  assert.equal(sim.metrics().awake, 0)
  sim.setReduced(false)
  assert.equal(sim.startDrag(sim.pieces()[0].id, [1, 2, 1]), true, 'Disabling reduced motion restores physical grabbing')
  sim.setReduced(true)
  assert.equal(sim.metrics().dragging, null)
  assert.equal(sim.metrics().awake, 0)
  report.push({ case: 'reduced-motion', ...sim.metrics() })
  sim.dispose()
}
for (const initialAmount of [DEMO_LIMIT, GOLD - STONE]) {
  const sim = new FreeReservePhysics(assets, initialAmount)
  const initial = new Map(sim.pieces().map(piece => [piece.id, piece.position]))
  step(sim, 1 / 60)
  const displacement = Math.max(...sim.pieces().map(piece => Math.hypot(...piece.position.map((value, axis) => value - initial.get(piece.id)[axis]))))
  assert.ok(displacement < .03, 'Large initial pile does not start deeply inside props or eject stones on its first step')
  const before = sim.time
  sim.advance(2)
  assert.ok(sim.time - before <= 2 / 60 + 1e-8, 'A background pause cannot trigger an unbounded physics catch-up')
  step(sim, 8)
  for (let i = 0; i < 48; i++) {
    sim.nudge([Math.cos(i * .47) * 8, Math.sin(i * .47) * 8])
    step(sim, .1)
  }
  step(sim, 4)
  assert.equal(sim.metrics().count, initialAmount === DEMO_LIMIT ? DEMO_LIMIT / GOLD : STONES_PER_GOLD - 1, 'Every denomination remains visible during repeated forceful orbit gestures')
  report.push({ case: initialAmount === DEMO_LIMIT ? 'safe-million-initialization' : '199-sandstone-forceful-orbit', firstStepMaxDisplacement: displacement, exactObstacleParts: sim.obstacleColliderCount, ...sim.metrics() })
  sim.dispose()
}
{
  const sim = new FreeReservePhysics(assets, GOLD)
  const initial = sim.pieces()[0]
  const candidates = Array.from({ length: 64 }, (_, i) => {
    const angle = i / 64 * Math.PI * 2
    const [x, z] = boundary.project(Math.cos(angle) * 40, Math.sin(angle) * 40, .75)
    return { x, z, ground: sim.terrainHeight(x, z), support: sim.footprintHeight(x, z, .58) }
  })
  const shore = candidates.find(point => point.support - point.ground < .18)
  assert.ok(shore, 'The real terrain has a coast location clear of authored fixed rock clusters')
  sim.startDrag(initial.id, [initial.position[0], 3.8, initial.position[2]])
  step(sim, 1.2)
  sim.moveDrag([shore.x, 3, shore.z])
  step(sim, 1.5)
  sim.moveDrag([shore.x, shore.ground + .7, shore.z])
  step(sim, 1)
  sim.endDrag()
  step(sim, .35)
  const gold = sim.pieces()[0]
  const coastDistance = boundary.clearance(gold.position[0], gold.position[2]).distance
  assert.ok(coastDistance < 1.3, 'The gold is genuinely at the dry shore before spending')
  commit(sim, 'expense', STONE)
  assert.equal(sim.pieces().filter(piece => !piece.spent).length, STONES_PER_GOLD - 1)
  step(sim, 8)
  report.push({ case: 'shore-gold-expense-splits-into-visible-change', coastDistanceBeforeSpend: coastDistance, ...sim.metrics() })
  sim.dispose()
}
{
  const sim = new FreeReservePhysics(assets, STONE)
  const id = sim.pieces()[0].id
  for (let i = 0; i < 8; i++) {
    const angle = i / 8 * Math.PI * 2
    const p = sim.pieces()[0].position
    assert.equal(sim.startDrag(id, [p[0], 3.8, p[2]]), true)
    step(sim, .6)
    sim.moveDrag([Math.cos(angle) * 40, 3.8, Math.sin(angle) * 40])
    step(sim, 1.8)
    sim.endDrag()
    step(sim, 2)
    const edge = sim.pieces()[0]
    assert.ok(boundary.contains(edge.position[0], edge.position[2]), 'Each shoreline direction physically retains the released stone')
    assert.equal(sim.startDrag(id, [edge.position[0], edge.position[1] + .8, edge.position[2]]), true)
    step(sim, .5)
    assert.ok(sim.pieces()[0].position[1] > edge.position[1] + .35, 'Each released edge remains regrabbable')
    sim.endDrag()
  }
  report.push({ case: 'eight-direction-shore-drag-release-regrab', ...sim.metrics() })
  sim.dispose()
}
{
  const sim = new FreeReservePhysics(assets, 0)
  commit(sim, 'income', DEMO_LIMIT - 1)
  const sandstone = sim.pieces().filter(piece => piece.kind === 'sand')
  assert.equal(sim.pieces().filter(piece => piece.kind === 'gold').length, Math.floor((DEMO_LIMIT - 1) / GOLD))
  assert.equal(sandstone.length, STONES_PER_GOLD, 'The largest non-round legal transfer includes 199 whole stones and fractional change')
  assert.ok(sandstone.every(piece => piece.position[1] > sim.terrainHeight(piece.position[0], piece.position[2]) + .02),
    'Gold denomination indices never shift the change cloud below the real island')
  assert.equal(sim.metrics().belowWater, 0, 'Every denomination is visible immediately on a mixed large deposit')
  step(sim, 8)
  report.push({ case: 'largest-mixed-transfer-cloud-change', minSandstoneBirthHeight: Math.min(...sandstone.map(piece => piece.position[1])), ...sim.metrics() })
  sim.dispose()
}
{
  const sim = new FreeReservePhysics(assets, 0)
  commit(sim, 'income', 1)
  step(sim, .1)
  let sweptBodies = 0
  sim.world.forEachRigidBody(body => { if (body.isCcdEnabled()) sweptBodies++ })
  assert.equal(sweptBodies, 1, 'Fast one-fen fragment retains swept collision protection')
  step(sim, 6)
  report.push({ case: 'tiny-fast-fragment-ccd', ...sim.metrics() })
  sim.dispose()
}
await writeFile('docs/free-physics-check.json', JSON.stringify({
  engine: 'Rapier 0.12.0', fixedStep: 1 / 60, actualExportedTerrainAndProps: true, assetHashes,
  denomination: { stonesPerGold: STONES_PER_GOLD, stoneFen: STONE, goldFen: GOLD },
  collisionProxy: assets.collisionProxy.diagnostics,
  shore: { height: boundary.height, segments: boundary.points.length, minimumRadius: boundary.minRadius, maximumRadius: boundary.maxRadius },
  cases: report,
}, null, 2))
console.log(JSON.stringify(report, null, 2))
