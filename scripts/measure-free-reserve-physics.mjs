import { performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import { FreeReservePhysics, physicsReady } from '../src/scene/FreeReservePhysics.ts'
import { freePhysicsFixture, physicsAssetHashes } from './physics-fixture.mjs'
import { GOLD, STONE, STONES_PER_GOLD, DEMO_LIMIT } from '../src/domain/reserve.ts'
import { CONTAINER } from '../src/scene/containerConfig.ts'

await physicsReady
const assets = await freePhysicsFixture()
const assetHashes = await physicsAssetHashes()
const started = performance.now()
const prepared = new FreeReservePhysics(assets, 8 * STONE)
const initialScenePreparationMs = performance.now() - started
const shore = {
  planeHeight: prepared.boundary.height, segments: prepared.boundary.points.length,
  minimumRadius: prepared.boundary.minRadius, maximumRadius: prepared.boundary.maxRadius,
}
const resetStart = performance.now()
prepared.sync(DEMO_LIMIT)
const millionResetWithCachedHeightMapMs = performance.now() - resetStart
prepared.dispose()
const cases = []
for (const [name, before, income = 0, expense = 0] of [
  ['two-hundred-cloud-stones', 0, GOLD],
  ['demo-eight-plus-192', STONE * 8, GOLD - STONE * 8],
  ['199-plus-one', GOLD - STONE, STONE],
  ['199-sandstone-initial-settling', GOLD - STONE],
  ['199-sandstone-repeated-orbit', GOLD - STONE],
  ['gold-split-199-and-fractional-change', GOLD, 0, 1],
  ['million-initial-settling', DEMO_LIMIT, 0],
  ['continuous-one-fen-and-stone-change', 0, 0],
  ['largest-mixed-transfer-cloud-change', 0, DEMO_LIMIT - 1],
]) {
  const init = performance.now(), sim = new FreeReservePhysics(assets, before)
  const creationMs = performance.now() - init
  const committedAt = performance.now()
  if (income) sim.commit({ id: name, type: 'income', amount: income, before, after: before + income })
  if (expense) sim.commit({ id: name, type: 'expense', amount: expense, before, after: before - expense })
  const initialCommitMs = income || expense ? performance.now() - committedAt : 0
  let continuousCommitMs = 0, maximumContinuousCommitMs = 0
  let worldStepMs = 0, terrainStabilizationMs = 0
  const worldStep = sim.world.step.bind(sim.world), stabilize = sim.stabilizeTerrainContacts.bind(sim)
  sim.world.step = (...args) => {
    const started = performance.now(); worldStep(...args); worldStepMs += performance.now() - started
  }
  sim.stabilizeTerrainContacts = () => {
    const started = performance.now(); stabilize(); terrainStabilizationMs += performance.now() - started
  }
  const samples = []
  const steps = name === 'continuous-one-fen-and-stone-change' ? 360 : 300
  for (let i = 0; i < steps; i++) {
    if (name === '199-sandstone-repeated-orbit' && i % 6 === 0) sim.nudge([Math.cos(i * .47) * 8, Math.sin(i * .47) * 8])
    if (name === 'continuous-one-fen-and-stone-change' && i % 3 === 0) {
      const started = performance.now()
      const index = i / 3, amount = index % 3 === 0 ? 2 * STONE : 1
      const balance = sim.interactionState().amount
      sim.commit({ id: `micro-income-${i}`, type: 'income', amount, before: balance, after: balance + amount })
      if (index % 4 === 0) {
        const before = sim.interactionState().amount
        sim.commit({ id: `micro-expense-${i}`, type: 'expense', amount: 1, before, after: before - 1 })
      }
      const elapsed = performance.now() - started
      continuousCommitMs += elapsed; maximumContinuousCommitMs = Math.max(maximumContinuousCommitMs, elapsed)
    }
    const start = performance.now()
    sim.advance(1 / 60)
    samples.push({ at: Number(sim.time.toFixed(4)), ms: Number((performance.now() - start).toFixed(3)) })
  }
  const ordered = [...samples].sort((a, b) => a.ms - b.ms)
  const contacts = { staticPairs: 0, dynamicPairs: 0, staticManifolds: 0, dynamicManifolds: 0, solverContacts: 0 }
  const visited = new Set()
  for (const item of sim.items) sim.world.narrowPhase.contactPairsWith(item.collider.handle, other => {
    const key = [item.collider.handle, other].sort((a, b) => a - b).join(':')
    if (visited.has(key)) return
    visited.add(key)
    const dynamic = !!sim.world.getCollider(other).parent()
    contacts[dynamic ? 'dynamicPairs' : 'staticPairs']++
    sim.world.narrowPhase.contactPair(item.collider.handle, other, manifold => {
      contacts[dynamic ? 'dynamicManifolds' : 'staticManifolds']++
      contacts.solverContacts += manifold.numSolverContacts()
    })
  })
  cases.push({
    name, steps, creationMs, initialCommitMs, continuousCommitMs, maximumContinuousCommitMs, obstacleColliderCount: sim.obstacleColliderCount,
    totalMs: samples.reduce((sum, item) => sum + item.ms, 0),
    phaseTotals: { worldStepMs, terrainStabilizationMs }, contactStatisticsAtEnd: contacts,
    p50Ms: ordered[Math.floor(steps * .5) - 1].ms, p95Ms: ordered[Math.floor(steps * .95) - 1].ms, maxMs: ordered.at(-1).ms,
    expensiveSteps: [...samples].sort((a, b) => b.ms - a.ms).slice(0, 8), metrics: sim.metrics(),
  })
  sim.dispose()
}
const report = {
  measuredAt: new Date().toISOString(), node: process.version, assetHashes,
  collisionProxy: assets.collisionProxy.diagnostics,
  configuration: { stonesPerGold: STONES_PER_GOLD, stoneFen: STONE, goldFen: GOLD, shore, waterRadius: CONTAINER.waterRadius, cloud: CONTAINER.cloud, dropRadius: CONTAINER.dropRadius },
  method: 'Actual exported sandstone/gold hulls; source-hash-bound, independently validated contact proxies for the GLB terrain and fixed props. Original mesh is retained for exact dry shore and terrain support queries. 300 fixed 1/60-second steps per ordinary case; 360 for continuous micro-change. Initial and continuous commit timings are separate from fixed-step timings. Node CPU timing only, not browser frame rate. No timing assertion in correctness tests.',
  changes: [
    'The visible denomination is 200 sandstone units per gold. Each stone still represents ¥100; gold is ¥20,000 at its unchanged 0.45 physical scale. Existing ledger amounts and history are unchanged.',
    'All discrete collisions stay enabled. Swept CCD is selected by per-step linear/angular travel versus scaled body thickness, retaining it for tiny or fast pieces.',
    'All disconnected fixed props remain present. Their baked contact surfaces and terrain proxy remove redundant triangles within independently sampled 5mm limits; original visual geometry is unchanged. No browser mesh simplification or additional runtime WASM module is used.',
    'A 128-square static height field is cached during scene preparation, only for safe initial footprint placement. Actual collision meshes continue to solve motion.',
    'No initial stone/stone or stone/prop deep penetrations. Background catch-up is bounded to two fixed steps per rendered frame.',
    'Birth placement finds unoccupied vertical intervals against every existing layer, without a height cutoff. Mixed transfers have separate gold/sand cloud indices and share non-overlapping cloud volume.',
    'Invisible walls follow the actual dry shore intersection at waterY + 0.05. Initial positions, bulk deposits, drag targets, splitting and merging all use the same per-piece inset contour.',
    'The original circular live-body relocation fallback is removed. A predictive boundary impulse limits outward motion without moving, suspending or freezing a body.',
    'Raised-cloud drops remain below the cloud and gather near the island. Faster downward travel near zero-thickness terrain enables CCD earlier; all existing friction, damping, mass and grab settings remain.',
    'Only micro-fragments with hull radius below 0.05 receive a 0.012 rounded contact shell, preserving their visual mesh and original mass/inertia while resisting multi-contact terrain tunnelling.',
    'Actual terrain ray normals provide contact error correction by impulse only after penetration exceeds 0.003 for micro-fragments or 0.035 for ordinary pieces. No extra ground surface, body relocation, sleep override or floating support is introduced.',
  ],
  initialScenePreparationMs, millionResetWithCachedHeightMapMs,
  previousMeasuredBeforeOptimization: {
    method: 'Same machine and actual assets; recorded before the v0.6 optimization at playRadius7.4/cloudY5.7, 300 fixed steps. Current configuration differs: these are historical diagnostic observations, not a controlled comparison of the new boundary/cloud layout.',
    cases: [
      { name: 'fifty-cloud-stones', totalMs: 385.54, maxMs: 34.9 },
      { name: 'forty-nine-plus-one', totalMs: 255.44, maxMs: 30.31 },
      { name: 'million-initial-settling', totalMs: 3407.96, maxMs: 75.82 },
    ],
  },
  cases,
}
await writeFile('docs/free-physics-performance.json', JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
