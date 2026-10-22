import assert from 'node:assert/strict'
import { soundEngine } from '../src/audio/soundEngine.ts'

let context, created = 0
const contexts = []
const bufferStarts = []
const parameter = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} })
const node = () => ({ connect() {}, disconnect() {}, gain: parameter(), frequency: parameter(), start() {}, stop() { this.onended?.() } })
globalThis.AudioContext = class {
  constructor() { contexts.push(this); created++; this.currentTime = 0; this.state = 'suspended'; this.sampleRate = 8000; this.destination = {} }
  createGain() { return node() }
  createBuffer() { return { getChannelData: () => new Float32Array(8000) } }
  createBufferSource() { return { ...node(), start(time, offset) { bufferStarts.push({ time, offset }) }, stop() {} } }
  createBiquadFilter() { return node() }
  createOscillator() { return { ...node(), stop() {} } }
  async resume() { this.state = 'running' }
}

soundEngine.play('stone')
await soundEngine.unlock()
assert.equal(created, 0, 'Default mute does not construct an audio device')
soundEngine.setEnabled(true)
soundEngine.play('stone')
assert.equal(soundEngine.inspect().played, 0, 'No play before user gesture unlock')
await soundEngine.unlock()
assert.equal(created, 1)
context = contexts[0]
soundEngine.play('stone')
soundEngine.play('stone')
assert.equal(soundEngine.inspect().played, 1, 'Contact cooldown rejects same-frame duplicates')
for (let i = 0; i < 30; i++) { context.currentTime += .1; soundEngine.play('stone') }
assert.equal(soundEngine.inspect().voices, 6, 'Strict polyphony bound during dense contacts')
assert.equal(soundEngine.inspect().peakVoices, 6)
soundEngine.setActive(false)
assert.equal(soundEngine.inspect().voices, 0, 'Background clears every voice')
const played = soundEngine.inspect().played
soundEngine.play('merge')
assert.equal(soundEngine.inspect().played, played, 'Background suppresses new sounds')
soundEngine.setActive(true)
soundEngine.play('merge')
assert.equal(soundEngine.inspect().voices, 1)
soundEngine.stop()
assert.equal(soundEngine.inspect().voices, 0, 'Skip cancels active and scheduled voices')
soundEngine.setReducedMotion(true)
soundEngine.play('fracture')
assert.equal(soundEngine.inspect().voices, 0)
soundEngine.setReducedMotion(false)
soundEngine.play('water')
assert.equal(soundEngine.inspect().voices, 1)
soundEngine.setEnabled(false)
assert.equal(soundEngine.inspect().voices, 0, 'Mute stops a sound already playing')
soundEngine.play('water')
assert.equal(soundEngine.inspect().voices, 0)
soundEngine.setEnabled(true)
context.currentTime = 2.9
soundEngine.play('merge')
assert.ok(bufferStarts.at(-1).offset + .64 < 1, 'Full merge chord finishes before its one-second noise buffer')
soundEngine.stop()
console.log('Sound lifecycle passed: unlock, cooldown, six-voice cap, background, skip, reduced motion, mute, complete merge tail.')
