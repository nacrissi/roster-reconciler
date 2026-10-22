// Tiny deterministic PRNG (mulberry32). Pure JS, no Node APIs, no imports.
// Same file runs unmodified under Node and Apps Script V8.
//
// Usage:
//   const rng = createPrng(7);
//   rng.next();        // float in [0, 1)
//   rng.int(0, 10);     // integer in [0, 10)
//   rng.pick(['a','b']); // random element
//   rng.chance(0.3);    // boolean, true ~30% of the time

function createPrng(seed) {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;

  function nextUint32() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  function next() {
    return nextUint32() / 4294967296;
  }

  function int(min, maxExclusive) {
    return min + Math.floor(next() * (maxExclusive - min));
  }

  function pick(items) {
    return items[int(0, items.length)];
  }

  function chance(probability) {
    return next() < probability;
  }

  return { next, int, pick, chance };
}

if (typeof module !== 'undefined') {
  module.exports = { createPrng };
}
