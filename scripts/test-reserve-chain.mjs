import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { physicsFixture } from './physics-fixture.mjs'
import { ReservePhysics, physicsReady, PHYSICS_SECONDS } from '../src/scene/reservePhysics.ts'
import { makeMotion, restingPieces } from '../src/scene/reserveMotion.ts'

await physicsReady
const assets = await physicsFixture()
const balances = [80000, 200000, 199999, 500000, 75000, 2000000, 1999999, 2000000, 0, 1]
const sim = new ReservePhysics(assets, restingPieces(balances[0]))
for (let step = 0; step <= Math.ceil(PHYSICS_SECONDS * 90); step++) sim.advance(1 / 90)
const report = []
for (let i = 1; i < balances.length; i++) {
  const before = balances[i - 1], after = balances[i]
  const transaction = { id: `settled-chain-${i}`, before, after, type: after > before ? 'income' : 'expense', amount: Math.abs(after - before) }
  // Reuse both the actual settled poses and the same WASM world, like the app.
  sim.reset(sim.pieces(), makeMotion(transaction))
  for (let step = 0; step <= Math.ceil(PHYSICS_SECONDS * 90); step++) {
    sim.advance(1 / 90)
    for (const piece of sim.pieces()) {
      assert.ok([...piece.position, ...piece.orientation].every(Number.isFinite))
      assert.ok(piece.position[1] > -1, `Chain ${before} -> ${after} falls through terrain at ${sim.time}: ${JSON.stringify(piece)}`)
    }
  }
  const pieces = sim.pieces()
  assert.equal(pieces.reduce((sum, piece) => sum + piece.value, 0), after)
  assert.equal(pieces.length, restingPieces(after).length)
  const speed = Math.max(0, ...sim.bodies.map(({ body }) => { const v = body.linvel(); return Math.hypot(v.x, v.y, v.z) }))
  assert.ok(speed < .25, `Chain ${before} -> ${after} does not settle: ${speed}`)
  for (const piece of pieces) assert.ok(piece.position[1] > .45 && Math.abs(piece.position[0]) < 4.5 && piece.position[2] < 3.9)
  report.push({ before, after, count: pieces.length, maximumFinalSpeed: speed })
}
sim.dispose()
await writeFile('docs/reserve-chain-check.json', JSON.stringify({ realExportedColliders: true, reusedSettledPoses: true, reusedWorld: true, cases: report }, null, 2))
console.log(`Settled reserve chain passed: ${report.length} sequential entries.`)
