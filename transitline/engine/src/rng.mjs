// Small serialisable PRNG used by the simulation. Keeping randomness in state
// makes replays, saves and speed-comparison tests deterministic.
export class DeterministicRng {
  constructor(seed = 0x6d2b79f5) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  next() {
    let t = (this.state += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  snapshot() {
    return this.state >>> 0;
  }

  restore(state) {
    this.state = state >>> 0 || 0x6d2b79f5;
  }
}

export function randomFrom(state) {
  return state.rng?.next ? () => state.rng.next() : Math.random;
}
