import { SOUNDS, type SoundEntry } from '../types.ts'
import { loadSounds, type Assets } from './assets.ts'

type Wave = OscillatorType | 'noise'

// One voice of a built-in sound: a wave, or noise through a filter, sliding from one frequency to another while it fades out.
interface Voice {
  readonly wave: Wave
  readonly from: number
  readonly to: number
  readonly seconds: number
  readonly after: number
  readonly volume: number
}

function voice(wave: Wave, from: number, to: number, seconds: number, { after = 0, volume = 0.5 } = {}): Voice {
  return { wave, from, to, seconds, after, volume }
}

const VOICES: Readonly<Record<(typeof SOUNDS)[number], readonly Voice[]>> = {
  blip: [voice('square', 880, 880, 0.07, { volume: 0.3 })],
  coin: [voice('square', 988, 988, 0.08, { volume: 0.3 }), voice('square', 1319, 1319, 0.3, { after: 0.08, volume: 0.3 })],
  explode: [voice('noise', 2400, 50, 0.8, { volume: 1 })],
  hit: [voice('square', 220, 80, 0.12, { volume: 0.4 }), voice('noise', 3000, 400, 0.08, { volume: 0.4 })],
  jump: [voice('square', 260, 780, 0.2, { volume: 0.3 })],
  lose: [voice('sawtooth', 460, 60, 1, { volume: 0.35 }), voice('square', 230, 30, 1, { volume: 0.15 })],
  score: [523, 659, 784, 1047].map((note, i) => voice('triangle', note, note, i === 3 ? 0.3 : 0.1, { after: i * 0.08 })),
  shoot: [voice('square', 1600, 200, 0.16, { volume: 0.25 })],
}

export class Speaker {
  readonly #context = new AudioContext()
  readonly #out = new GainNode(this.#context, { gain: 0.5 })
  readonly #noise = noise(this.#context)
  #files: ReadonlyMap<string, AudioBuffer> = new Map()

  constructor(assets: Assets) {
    this.#out.connect(this.#context.destination)
    loadSounds(assets, this.#context).then(
      (files) => (this.#files = files),
      (error: unknown) => console.error(error),
    )
  }

  // Browsers keep a page silent until a key or button press.
  unlock(): void {
    if (this.#context.state === 'suspended') void this.#context.resume()
  }

  play({ name, volume, pitch }: SoundEntry): void {
    if (this.#context.state !== 'running' || volume === 0) return
    const now = this.#context.currentTime
    const file = this.#files.get(name)
    if (file !== undefined) {
      const source = new AudioBufferSourceNode(this.#context, { buffer: file, playbackRate: pitch })
      source.connect(new GainNode(this.#context, { gain: volume })).connect(this.#out)
      source.start(now)
      return
    }
    const builtIn = SOUNDS.find((sound) => sound === name)
    for (const each of builtIn === undefined ? [] : VOICES[builtIn]) this.#voice(each, now, volume, pitch)
  }

  #voice({ wave, from, to, seconds, after, volume: loudness }: Voice, now: number, volume: number, pitch: number): void {
    const context = this.#context
    const [begin, end] = [now + after, now + after + seconds]
    const gain = new GainNode(context, { gain: 0 })
    gain.gain.setValueAtTime(0, begin)
    gain.gain.linearRampToValueAtTime(loudness * volume, begin + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, end)
    gain.connect(this.#out)
    const slide = (frequency: AudioParam) => {
      frequency.setValueAtTime(from * pitch, begin)
      frequency.exponentialRampToValueAtTime(to * pitch, end)
    }
    if (wave === 'noise') {
      const filter = new BiquadFilterNode(context, { type: 'lowpass' })
      slide(filter.frequency)
      const source = new AudioBufferSourceNode(context, { buffer: this.#noise, loop: true })
      source.connect(filter).connect(gain)
      source.start(begin)
      source.stop(end)
    } else {
      const source = new OscillatorNode(context, { type: wave })
      slide(source.frequency)
      source.connect(gain)
      source.start(begin)
      source.stop(end)
    }
  }
}

function noise(context: BaseAudioContext): AudioBuffer {
  const buffer = new AudioBuffer({ length: context.sampleRate, sampleRate: context.sampleRate })
  const samples = buffer.getChannelData(0)
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1
  return buffer
}
