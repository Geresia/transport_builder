// Deterministic ids for the map layer: the same inputs always give the same id.
// No clock, no RNG, no draw-order counters — so a re-opened map keeps its plan ids.

function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// 64 bits (two FNV-1a passes with different seeds) — plenty for one map's worth of ids.
// ponytail: not collision-proof; move to a real hash if ids ever have to be globally unique.
export function stableId(prefix, ...parts) {
  const s = parts.join("\u001f");
  const hex = (n) => n.toString(16).padStart(8, "0");
  return `${prefix}:${hex(fnv1a(s, 0x811c9dc5))}${hex(fnv1a(s, 0x01000193))}`;
}

export const roundTo = (n, digits) => {
  const k = 10 ** digits;
  return Math.round(n * k) / k + 0; // + 0 turns -0 into 0
};

// ~0.1 m at Tokyo's latitude: coordinates that differ below this are the same place.
export const round6 = (n) => roundTo(n, 6);

export const coordKey = ([lon, lat]) => `${round6(lon).toFixed(6)},${round6(lat).toFixed(6)}`;
