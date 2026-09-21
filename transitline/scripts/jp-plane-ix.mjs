// JGD2011 / Japan Plane Rectangular CS IX (Tokyo, Kanto core): forward and inverse Transverse Mercator (GRS80).
// Shapefiles from the Tokyo land use survey use this system: X = easting (m), Y = northing (m).
// Forward is the series used by the other tokyo scripts; inverse is the standard footpoint-latitude series. `node scripts/jp-plane-ix.mjs` self-tests
// the round trip.
const A = 6378137, F = 1 / 298.257222101, E2 = F * (2 - F), EP2 = E2 / (1 - E2), N = F / (2 - F);
const LON0 = 139 + 50 / 60, LAT0 = 36, K0 = 0.9999, D2R = Math.PI / 180;
const a0 = 1 + N * N / 4 + N ** 4 / 64, a1 = -1.5 * (N - N ** 3 / 8), a2 = 0.9375 * (N * N - N ** 4 / 4), a3 = -35 / 48 * N ** 3, a4 = 315 / 512 * N ** 4;
const arc = (p) => A / (1 + N) * (a0 * p + a1 * Math.sin(2 * p) + a2 * Math.sin(4 * p) + a3 * Math.sin(6 * p) + a4 * Math.sin(8 * p));
const S0 = arc(LAT0 * D2R);

export function toPlane(lon, lat) { // -> [easting, northing]
  const p = lat * D2R, dl = (lon - LON0) * D2R, sp = Math.sin(p), cp = Math.cos(p), t = Math.tan(p), eta2 = EP2 * cp * cp, nu = A / Math.sqrt(1 - E2 * sp * sp);
  const x = K0 * (arc(p) - S0 + nu * sp * cp * dl * dl / 2 * (1 + dl * dl * cp * cp / 12 * (5 - t * t + 9 * eta2 + 4 * eta2 * eta2)));
  const y = K0 * nu * cp * dl * (1 + dl * dl * cp * cp / 6 * (1 - t * t + eta2) + dl ** 4 * cp ** 4 / 120 * (5 - 18 * t * t + t ** 4));
  return [y, x];
}

const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
const M = (p) => A * ((1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256) * p - (3 * E2 / 8 + 3 * E2 ** 2 / 32 + 45 * E2 ** 3 / 1024) * Math.sin(2 * p) + (15 * E2 ** 2 / 256 + 45 * E2 ** 3 / 1024) * Math.sin(4 * p) - (35 * E2 ** 3 / 3072) * Math.sin(6 * p));
const M0 = M(LAT0 * D2R);
export function toLonLat(easting, northing) { // -> [lon, lat]
  const m = M0 + northing / K0, mu = m / (A * (1 - E2 / 4 - 3 * E2 ** 2 / 64 - 5 * E2 ** 3 / 256));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const s = Math.sin(p1), c = Math.cos(p1), t1 = Math.tan(p1) ** 2, c1 = EP2 * c * c, n1 = A / Math.sqrt(1 - E2 * s * s), r1 = A * (1 - E2) / (1 - E2 * s * s) ** 1.5, d = easting / (n1 * K0);
  const lat = p1 - (n1 * Math.tan(p1) / r1) * (d * d / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * EP2) * d ** 4 / 24 + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * EP2 - 3 * c1 * c1) * d ** 6 / 720);
  const lon = LON0 * D2R + (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * EP2 + 24 * t1 * t1) * d ** 5 / 120) / c;
  return [lon / D2R, lat / D2R];
}

if (process.argv[1] && process.argv[1].endsWith("jp-plane-ix.mjs")) {
  let seed = 1; const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  let worst = 0;
  for (let i = 0; i < 200000; i++) { // whole Kanto region
    const lon = 138.2 + r() * 2.6, lat = 34.9 + r() * 2.25, [x, y] = toPlane(lon, lat), [lo, la] = toLonLat(x, y);
    worst = Math.max(worst, Math.hypot((lo - lon) * 111320 * Math.cos(lat * D2R), (la - lat) * 111320));
  }
  console.log("round-trip worst error (m):", worst.toExponential(2), worst < 0.01 ? "ok" : "FAIL");
  // known point: Tokyo Station 35.681236, 139.767125 -> expect small positive easting east of 139.8333 meridian? (west => negative) and northing ~ -35.9 km
  console.log("Tokyo Station ->", toPlane(139.767125, 35.681236).map((v) => v.toFixed(1)));
  process.exit(worst < 0.01 ? 0 : 1);
}
