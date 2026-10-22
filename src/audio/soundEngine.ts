export type ReserveSound = 'stone' | 'gold' | 'merge' | 'fracture' | 'water' | 'arrival'

/** Original procedural foley. No media fetch, autoplay, or delayed sound queue. */
class IslandSound {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private enabled = false
  private active = true
  private reduced = false
  private voices = new Set<{ sources: AudioScheduledSourceNode[]; gain: GainNode }>()
  private last = new Map<ReserveSound, number>()
  private played = 0
  private peakVoices = 0

  setEnabled(value: boolean) { this.enabled = value; if (!value) this.stop() }
  setActive(value: boolean) { this.active = value; if (!value) this.stop() }
  setReducedMotion(value: boolean) { this.reduced = value; if (value) this.stop() }
  inspect() {
    return { enabled: this.enabled, active: this.active, reduced: this.reduced, voices: this.voices.size, peakVoices: this.peakVoices, played: this.played, contextState: this.context?.state ?? 'uninitialized' }
  }
  async unlock(): Promise<void> {
    if (!this.enabled || !this.active || this.reduced || typeof AudioContext === 'undefined') return
    try {
      if (!this.context) {
        this.context = new AudioContext()
        this.master = this.context.createGain()
        this.master.gain.value = .34
        this.master.connect(this.context.destination)
        this.noise = this.context.createBuffer(1, this.context.sampleRate, this.context.sampleRate)
        const data = this.noise.getChannelData(0)
        let previous = 0
        for (let i = 0; i < data.length; i++) {
          previous = (previous + (Math.random() * 2 - 1) * .08) / 1.08
          data[i] = previous * 3.5
        }
      }
      if (this.context.state === 'suspended') await this.context.resume()
    } catch { /* Audio is optional; an unavailable device never blocks a ledger entry. */ }
  }
  stop() {
    for (const voice of this.voices) {
      voice.gain.disconnect()
      for (const source of voice.sources) {
        try { source.stop() } catch { /* An already-ended voice is harmless. */ }
        source.disconnect()
      }
    }
    this.voices.clear()
    this.last.clear()
  }
  play(kind: ReserveSound, strength = .7) {
    const context = this.context
    if (!this.enabled || !this.active || this.reduced || !context || context.state !== 'running' || !this.master || !this.noise) return
    const now = context.currentTime
    const cooldown = kind === 'stone' || kind === 'gold' ? .095 : .18
    if (now - (this.last.get(kind) ?? -1) < cooldown || this.voices.size >= 6) return
    this.last.set(kind, now)
    const gain = context.createGain()
    gain.connect(this.master)
    const sources: AudioScheduledSourceNode[] = []
    const voice = { sources, gain }
    this.voices.add(voice)
    this.played++
    this.peakVoices = Math.max(this.peakVoices, this.voices.size)
    const duration = kind === 'merge' ? .64 : kind === 'water' ? .28 : kind === 'fracture' ? .3 : .17
    const volume = Math.max(.08, Math.min(1, strength))
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(volume * (kind === 'merge' ? .17 : .2), now + .006)
    gain.gain.exponentialRampToValueAtTime(.0001, now + duration)
    const noise = context.createBufferSource()
    noise.buffer = this.noise
    const filter = context.createBiquadFilter()
    filter.type = kind === 'water' ? 'bandpass' : 'lowpass'
    filter.frequency.setValueAtTime(kind === 'fracture' ? 1900 : kind === 'water' ? 1300 : 650, now)
    filter.frequency.exponentialRampToValueAtTime(180, now + duration)
    noise.connect(filter); filter.connect(gain)
    // Keep at least .75 seconds in the buffer so the longest (.64s) merge
    // voice cannot end early and disconnect the shared chord gain.
    noise.start(now, (now * .17) % .25); noise.stop(now + duration)
    sources.push(noise)
    const notes = kind === 'merge' ? [523.25, 783.99, 1046.5] : [kind === 'gold' ? 220 : kind === 'fracture' ? 93 : kind === 'water' ? 340 : 140]
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator(), tone = context.createGain()
      oscillator.type = kind === 'merge' || kind === 'gold' ? 'sine' : 'triangle'
      const at = now + index * .055
      oscillator.frequency.setValueAtTime(frequency, at)
      oscillator.frequency.exponentialRampToValueAtTime(frequency * (kind === 'merge' ? .998 : .55), now + duration)
      tone.gain.setValueAtTime(kind === 'merge' ? .25 : .45, at)
      tone.gain.exponentialRampToValueAtTime(.0001, now + duration)
      oscillator.connect(tone); tone.connect(gain)
      oscillator.start(at); oscillator.stop(now + duration)
      sources.push(oscillator)
      oscillator.onended = () => { oscillator.disconnect(); tone.disconnect() }
    })
    noise.onended = () => { noise.disconnect(); filter.disconnect(); gain.disconnect(); this.voices.delete(voice) }
  }
}

export const soundEngine = new IslandSound()
