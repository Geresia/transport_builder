// Approximate routed driving distance/time between two points, for demand_data.json's pops (`drivingDistance`
// metres, `drivingSeconds`). We have no routing engine, so this is straight-line distance x a detour factor,
// divided by a distance-dependent speed.
//
// The factors are NOT invented: on 2026-09-24 they were measured as medians over the real game's own installed
// Tokyo demand file (read locally for comparison only - 82,662 pops; only these 8 summary rows are kept here, no
// per-record data), bucketing each pop by the straight-line distance between its residence and job points and
// taking the median of (routed distance / straight-line) and of (routed distance / routed seconds):
//
//   straight-line   n       detour   speed
//   0-1 km          886     1.500    5.61 m/s (20 km/h)
//   1-2 km          2,700   1.409    6.06
//   2-4 km          7,218   1.357    6.47
//   4-8 km          14,112  1.350    7.63
//   8-16 km         22,579  1.390   10.02
//   16-32 km        23,769  1.396   12.11
//   32-64 km        10,755  1.391   14.21
//   64+ km          643     1.388   15.41 (55 km/h)
//
// (Pops under 50 m apart were excluded from that fit.) Still an approximation of *our* geography - a real value
// needs a routing engine over the real road network - but it puts our numbers on the same scale the game's own
// data uses, unlike the flat "25 km/h in a straight line" this replaces (which under-counted distance ~1.4x and
// mis-timed long trips badly).
const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;
export function haversineMeters([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// [straight-line lower bound in metres, detour factor, speed in m/s]
const TABLE = [
  [0, 1.5, 5.61], [1000, 1.409, 6.06], [2000, 1.357, 6.47], [4000, 1.35, 7.63],
  [8000, 1.39, 10.02], [16000, 1.396, 12.11], [32000, 1.391, 14.21], [64000, 1.388, 15.41],
];

export function drivingFor(fromLoc, toLoc) {
  const straight = haversineMeters(fromLoc, toLoc);
  let row = TABLE[0];
  for (const r of TABLE) if (straight >= r[0]) row = r;
  const distance = straight * row[1];
  return { drivingSeconds: Math.max(60, Math.round(distance / row[2])), drivingDistance: Math.round(distance) };
}
