// Dijkstra over the (station, line) graph from network.mjs. Small graphs
// (tens of stations) so an O(V^2) scan is plenty and needs no dependency.

export function findRoute(graph, originId, destinationId) {
  if (originId === destinationId) return [];

  const originLines = graph.stationLines.get(originId);
  const destLines = graph.stationLines.get(destinationId);
  if (!originLines || !destLines) return null; // one endpoint has no line at all

  const dist = new Map();
  const prev = new Map();
  const visited = new Set();
  for (const lineId of originLines) dist.set(`${originId}|${lineId}`, 0);

  for (;;) {
    let u = null;
    let best = Infinity;
    for (const [node, d] of dist) {
      if (!visited.has(node) && d < best) {
        best = d;
        u = node;
      }
    }
    if (u === null) break;
    visited.add(u);
    if (u.startsWith(`${destinationId}|`)) break;

    for (const { to, weight } of graph.adj.get(u) ?? []) {
      const nd = best + weight;
      if (nd < (dist.get(to) ?? Infinity)) {
        dist.set(to, nd);
        prev.set(to, u);
      }
    }
  }

  let endNode = null;
  let endDist = Infinity;
  for (const [node, d] of dist) {
    if (node.startsWith(`${destinationId}|`) && d < endDist) {
      endDist = d;
      endNode = node;
    }
  }
  if (endNode === null) return null; // not connected yet

  const path = [endNode];
  for (let cur = endNode; prev.has(cur); cur = prev.get(cur)) path.push(prev.get(cur));
  path.reverse();

  // Collapse consecutive same-line nodes into board/alight hops.
  const hops = [];
  for (const node of path) {
    const sep = node.lastIndexOf("|");
    const stationId = node.slice(0, sep);
    const lineId = Number(node.slice(sep + 1));
    const last = hops[hops.length - 1];
    if (last && last.lineId === lineId) {
      last.alightStationId = stationId;
    } else {
      hops.push({ lineId, boardStationId: stationId, alightStationId: stationId });
    }
  }
  return hops;
}
