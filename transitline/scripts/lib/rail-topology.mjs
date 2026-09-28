// Pure helpers for scripts/tokyo-station-network-mlit.mjs: cluster same-named station records that sit within a
// walking distance of each other into one physical station, then reconstruct each line's ordered station sequence
// from a bag of inter-station segments by finding the longest path through the segment graph (see that script's
// header comment for why: MLIT's N02 dataset gives segments and per-line station stops as separate, unordered
// records, unlike OSM's route relations which already list stops in order). No npm dependency: plain graph code.
const haversine = ([lon1, lat1], [lon2, lat2]) => {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

// Union-find over points that share the SAME name and lie within maxDistM of each other (real terminal complexes
// span several hundred metres across operators - e.g. Shinjuku's own platforms are ~700 m apart). Two different real
// stations that happen to share a name are assumed to be farther apart than that; a same-named pair closer than the
// threshold is a rare, accepted risk (documented in the caller).
export function clusterStations(records, maxDistM = 700) {
  // records: [{ name, point: [lon, lat], ...rest }]
  const byName = new Map();
  records.forEach((r, i) => (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)).push(i));
  const parent = records.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };

  for (const idx of byName.values()) {
    for (let i = 0; i < idx.length; i++) for (let j = i + 1; j < idx.length; j++) {
      if (haversine(records[idx[i]].point, records[idx[j]].point) <= maxDistM) union(idx[i], idx[j]);
    }
  }

  const groups = new Map();
  records.forEach((r, i) => { const root = find(i); (groups.get(root) ?? groups.set(root, []).get(root)).push(r); });
  return [...groups.values()].map((group) => {
    const lon = group.reduce((s, r) => s + r.point[0], 0) / group.length;
    const lat = group.reduce((s, r) => s + r.point[1], 0) / group.length;
    return { name: group[0].name, location: [lon, lat], members: group };
  });
}

// Weighted-graph "diameter": BFS/Dijkstra from an arbitrary node to its farthest point A, then from A to its
// farthest point B; the A-B shortest path is exact for a tree (the usual case: a line with no junction loop) and a
// reasonable stand-in for one with a stray cycle (double-digitised track, or a genuine loop line - see the caller,
// which explains why approximating a loop as its longest chord fits this engine's non-looping line model anyway).
function farthest(adj, start) {
  const dist = new Map([[start, 0]]), prev = new Map(), visited = new Set();
  while (visited.size < dist.size) {
    let u = null, best = Infinity;
    for (const [node, d] of dist) if (!visited.has(node) && d < best) { best = d; u = node; }
    if (u === null) break;
    visited.add(u);
    for (const { to, lengthM } of adj.get(u) ?? []) {
      const d = best + lengthM;
      if (d < (dist.get(to) ?? Infinity)) { dist.set(to, d); prev.set(to, u); }
    }
  }
  let far = start, farD = 0;
  for (const [node, d] of dist) if (d > farD) { farD = d; far = node; }
  return { node: far, distance: farD, prev };
}

// segments: [{ from, to, lengthM }] (station ids as returned by clusterStations, keyed by the caller).
// Returns the ordered station id path of the longest chain, or null if the graph has fewer than 2 stations.
export function longestPath(segments) {
  const adj = new Map();
  const add = (a, b, lengthM) => (adj.get(a) ?? adj.set(a, []).get(a)).push({ to: b, lengthM });
  const nodes = new Set();
  for (const { from, to, lengthM } of segments) {
    if (from === to) continue; // a zero-length or self-referential segment carries no order information
    add(from, to, lengthM); add(to, from, lengthM);
    nodes.add(from); nodes.add(to);
  }
  if (nodes.size < 2) return null;
  const start = nodes.values().next().value;
  const a = farthest(adj, start);
  const b = farthest(adj, a.node);
  const path = [b.node];
  for (let cur = b.node; cur !== a.node; ) { cur = b.prev.get(cur); path.push(cur); }
  return path.length >= 2 ? path : null;
}
