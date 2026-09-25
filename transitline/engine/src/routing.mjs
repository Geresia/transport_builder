// Dijkstra over the (station, line) graph from network.mjs. A binary heap and
// per-graph origin/destination cache keep repeated passenger routing cheap.

const routeCaches = new WeakMap();

class MinHeap {
  constructor() {
    this.items = [];
  }

  push(node, distance) {
    const item = { node, distance };
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent].distance <= distance) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = item;
  }

  pop() {
    if (this.items.length === 0) return null;
    const root = this.items[0];
    const tail = this.items.pop();
    if (this.items.length && tail) {
      let i = 0;
      while (true) {
        const left = i * 2 + 1;
        if (left >= this.items.length) break;
        const right = left + 1;
        const child = right < this.items.length && this.items[right].distance < this.items[left].distance ? right : left;
        if (this.items[child].distance >= tail.distance) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = tail;
    }
    return root;
  }
}

function splitNode(node) {
  const sep = node.lastIndexOf("|");
  return { stationId: node.slice(0, sep), lineId: Number(node.slice(sep + 1)) };
}

// Returns { hops, seconds } (in-vehicle + transfer time, excluding first wait)
// or null when the stations are not connected.
export function findRoute(graph, originId, destinationId) {
  if (originId === destinationId) return { hops: [], seconds: 0 };
  let cache = routeCaches.get(graph);
  if (!cache) {
    cache = new Map();
    routeCaches.set(graph, cache);
  }
  const cacheKey = `${originId}\u0000${destinationId}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const originLines = graph.stationLines.get(originId);
  const destLines = graph.stationLines.get(destinationId);
  if (!originLines || !destLines) {
    cache.set(cacheKey, null);
    return null;
  }

  const dist = new Map();
  const prev = new Map();
  const heap = new MinHeap();
  for (const lineId of originLines) {
    const node = `${originId}|${lineId}`;
    dist.set(node, 0);
    heap.push(node, 0);
  }

  let endNode = null;
  while (heap.items.length) {
    const current = heap.pop();
    if (current.distance !== dist.get(current.node)) continue;
    if (splitNode(current.node).stationId === destinationId) {
      endNode = current.node;
      break;
    }
    for (const { to, weight } of graph.adj.get(current.node) ?? []) {
      const nextDistance = current.distance + weight;
      if (nextDistance >= (dist.get(to) ?? Infinity)) continue;
      dist.set(to, nextDistance);
      prev.set(to, current.node);
      heap.push(to, nextDistance);
    }
  }

  if (endNode === null) {
    cache.set(cacheKey, null);
    return null;
  }
  const path = [endNode];
  for (let cur = endNode; prev.has(cur); cur = prev.get(cur)) path.push(prev.get(cur));
  path.reverse();

  const hops = [];
  for (const node of path) {
    const { stationId, lineId } = splitNode(node);
    const last = hops[hops.length - 1];
    if (last && last.lineId === lineId) last.alightStationId = stationId;
    else hops.push({ lineId, boardStationId: stationId, alightStationId: stationId });
  }
  const result = { hops, seconds: dist.get(endNode) };
  cache.set(cacheKey, result);
  return result;
}
