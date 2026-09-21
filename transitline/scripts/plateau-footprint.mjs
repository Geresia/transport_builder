// Footprint area (m2) per building from a PLATEAU LOD1 b3dm tile, computed from the mesh: positions are
// ECEF metres relative to CESIUM_RTC, so a triangle's horizontal area is |area-vector . up| with up = the
// radial direction at the triangle (after the glTF Y-up -> Z-up rotation). Caps (roof, and floor if present) carry it; walls contribute ~0.
// Returns Float64Array: horizontal triangle area per batch id. LOD1 meshes have a roof AND a floor, so the
// footprint of a part is half of this (verified: mesh / 図上面積 = 2.0 for single-part buildings).
export function meshHorizontalArea(b3dm, batchLength) {
  const ftJ = b3dm.readUInt32LE(12), ftB = b3dm.readUInt32LE(16), btJ = b3dm.readUInt32LE(20), btB = b3dm.readUInt32LE(24);
  const glb = b3dm.subarray(28 + ftJ + ftB + btJ + btB);
  const jl = glb.readUInt32LE(12), j = JSON.parse(glb.subarray(20, 20 + jl).toString("utf8"));
  const binOff = 20 + jl + 8;
  const c = j.extensions?.CESIUM_RTC?.center ?? [0, 0, 0];
  const acc = (i) => {
    const a = j.accessors[i], v = j.bufferViews[a.bufferView], o = binOff + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    return { a, o, stride: v.byteStride ?? 0 };
  };
  const pos = acc(j.meshes[0].primitives[0].attributes.POSITION), bid = acc(j.meshes[0].primitives[0].attributes._BATCHID);
  const copy = (o, bytes) => { const ab = new ArrayBuffer(bytes); Buffer.from(ab).set(glb.subarray(o, o + bytes)); return ab; };
  const V = new Float32Array(copy(pos.o, pos.a.count * 12)), B = bid.a.componentType === 5121 ? new Uint8Array(copy(bid.o, bid.a.count)) : bid.a.componentType === 5125 ? new Uint32Array(copy(bid.o, bid.a.count * 4)) : new Uint16Array(copy(bid.o, bid.a.count * 2)); // _BATCHID width varies by tile
  const areas = new Float64Array(batchLength);
  for (const prim of j.meshes[0].primitives) {
    const ix = acc(prim.indices), wide = ix.a.componentType === 5125;
    const I = wide ? new Uint32Array(copy(ix.o, ix.a.count * 4)) : new Uint16Array(copy(ix.o, ix.a.count * 2));
    for (let t = 0; t < ix.a.count; t += 3) {
      const i0 = I[t], i1 = I[t + 1], i2 = I[t + 2];
      const p0 = [V[3 * i0], V[3 * i0 + 1], V[3 * i0 + 2]], p1 = [V[3 * i1], V[3 * i1 + 1], V[3 * i1 + 2]], p2 = [V[3 * i2], V[3 * i2 + 1], V[3 * i2 + 2]];
      const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], v = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      // glTF is Y-up, the tile/ECEF frame is Z-up: (x, y, z) -> (x, -z, y). Rotate the normal and the position alike.
      const nr = [n[0], -n[2], n[1]], e = [c[0] + p0[0], c[1] - p0[2], c[2] + p0[1]], el = Math.hypot(e[0], e[1], e[2]);
      const h = Math.abs(nr[0] * e[0] + nr[1] * e[1] + nr[2] * e[2]) / el / 2;
      areas[B[i0]] += h;
    }
  }
  return areas;
}
