// Footprint area (m2) per building from a PLATEAU LOD1 b3dm tile, computed from the mesh: positions are
// ECEF metres relative to CESIUM_RTC, so a triangle's horizontal area is |area-vector . up| with up = the
// radial direction at the triangle (after the glTF Y-up -> Z-up rotation). Caps (roof, and floor if present) carry it; walls contribute ~0.
// Returns Float64Array: horizontal triangle area per batch id. LOD1 meshes have a roof AND a floor, so the
// footprint of a part is half of this (verified: mesh / 図上面積 = 2.0 for single-part buildings).
//
// Two mesh encodings exist. Older FME exports (Saitama/Kawasaki/Yokosuka 2020) store plain accessors that this
// file reads directly. Newer ones (Sagamihara 2020's "FME 2023.1.2.0", and every 2022+ export: Atsugi, Kamakura,
// Fujisawa, Yachiyo, Chiba-shi, ...) require KHR_draco_mesh_compression: accessors carry no bufferView at all and
// the vertices sit Draco-encoded in a shared bufferView. Those need the `draco3d` npm decoder, loaded once via
// `await loadDraco()` (looks in $DEPS/node_modules, e.g. DEPS=<dir> where `npm install draco3d` was run). If it
// was not loaded, meshHorizontalArea() returns null for a Draco tile and the caller treats every building in it
// as having no mesh footprint (buildings with a real surveyed 延床面積 are unaffected).
import path from "path";
import { createRequire } from "module";

let draco = null;
export async function loadDraco() {
  if (draco) return true;
  try {
    const req = createRequire(path.resolve(process.env.DEPS || ".", "x.js"));
    draco = await req("draco3d").createDecoderModule({});
    return true;
  } catch { return false; }
}

// Decode one Draco-compressed primitive -> { V: Float32Array xyz, B: batch id per vertex, I: Uint32Array indices }
function decodeDracoPrimitive(glb, j, binOff, prim) {
  const ext = prim.extensions.KHR_draco_mesh_compression, bv = j.bufferViews[ext.bufferView];
  const bytes = glb.subarray(binOff + (bv.byteOffset ?? 0), binOff + (bv.byteOffset ?? 0) + bv.byteLength);
  const decoder = new draco.Decoder(), buf = new draco.DecoderBuffer();
  buf.Init(new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length), bytes.length);
  const mesh = new draco.Mesh();
  const status = decoder.DecodeBufferToMesh(buf, mesh);
  if (!status.ok() || mesh.ptr === 0) throw new Error("draco decode failed: " + status.error_msg());
  const nPts = mesh.num_points(), nFaces = mesh.num_faces();
  const floats = (uniqueId, comps) => {
    const attr = decoder.GetAttributeByUniqueId(mesh, uniqueId), arr = new draco.DracoFloat32Array();
    decoder.GetAttributeFloatForAllPoints(mesh, attr, arr);
    const out = new Float32Array(nPts * comps);
    for (let k = 0; k < out.length; k++) out[k] = arr.GetValue(k);
    draco.destroy(arr);
    return out;
  };
  const V = floats(ext.attributes.POSITION, 3), Bf = floats(ext.attributes._BATCHID, 1);
  const B = new Uint32Array(nPts); for (let k = 0; k < nPts; k++) B[k] = Math.round(Bf[k]);
  const ptr = draco._malloc(nFaces * 3 * 4);
  decoder.GetTrianglesUInt32Array(mesh, nFaces * 3 * 4, ptr);
  const I = new Uint32Array(draco.HEAPU32.buffer.slice(ptr, ptr + nFaces * 3 * 4));
  draco._free(ptr);
  draco.destroy(mesh); draco.destroy(buf); draco.destroy(decoder);
  return { V, B, I };
}

export function meshHorizontalArea(b3dm, batchLength) {
  const ftJ = b3dm.readUInt32LE(12), ftB = b3dm.readUInt32LE(16), btJ = b3dm.readUInt32LE(20), btB = b3dm.readUInt32LE(24);
  const glb = b3dm.subarray(28 + ftJ + ftB + btJ + btB);
  const jl = glb.readUInt32LE(12), j = JSON.parse(glb.subarray(20, 20 + jl).toString("utf8"));
  const isDraco = !!j.extensionsRequired?.includes("KHR_draco_mesh_compression");
  if (isDraco && !draco) return null;
  const binOff = 20 + jl + 8;
  const c = j.extensions?.CESIUM_RTC?.center ?? [0, 0, 0];
  const areas = new Float64Array(batchLength);

  const accumulate = (V, B, I) => {
    for (let t = 0; t + 2 < I.length; t += 3) {
      const i0 = I[t], i1 = I[t + 1], i2 = I[t + 2];
      const p0 = [V[3 * i0], V[3 * i0 + 1], V[3 * i0 + 2]], p1 = [V[3 * i1], V[3 * i1 + 1], V[3 * i1 + 2]], p2 = [V[3 * i2], V[3 * i2 + 1], V[3 * i2 + 2]];
      const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], v = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      // glTF is Y-up, the tile/ECEF frame is Z-up: (x, y, z) -> (x, -z, y). Rotate the normal and the position alike.
      const nr = [n[0], -n[2], n[1]], e = [c[0] + p0[0], c[1] - p0[2], c[2] + p0[1]], el = Math.hypot(e[0], e[1], e[2]);
      const h = Math.abs(nr[0] * e[0] + nr[1] * e[1] + nr[2] * e[2]) / el / 2;
      const bi = B[i0]; if (bi < batchLength) areas[bi] += h;
    }
  };

  if (isDraco) {
    for (const prim of j.meshes[0].primitives) {
      const { V, B, I } = decodeDracoPrimitive(glb, j, binOff, prim);
      accumulate(V, B, I);
    }
    return areas;
  }

  const acc = (i) => {
    const a = j.accessors[i], v = j.bufferViews[a.bufferView], o = binOff + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    return { a, o, stride: v.byteStride ?? 0 };
  };
  const pos = acc(j.meshes[0].primitives[0].attributes.POSITION), bid = acc(j.meshes[0].primitives[0].attributes._BATCHID);
  const copy = (o, bytes) => { const ab = new ArrayBuffer(bytes); Buffer.from(ab).set(glb.subarray(o, o + bytes)); return ab; };
  const V = new Float32Array(copy(pos.o, pos.a.count * 12)), B = bid.a.componentType === 5121 ? new Uint8Array(copy(bid.o, bid.a.count)) : bid.a.componentType === 5125 ? new Uint32Array(copy(bid.o, bid.a.count * 4)) : new Uint16Array(copy(bid.o, bid.a.count * 2)); // _BATCHID width varies by tile
  for (const prim of j.meshes[0].primitives) {
    const ix = acc(prim.indices), wide = ix.a.componentType === 5125;
    const I = wide ? new Uint32Array(copy(ix.o, ix.a.count * 4)) : new Uint16Array(copy(ix.o, ix.a.count * 2));
    accumulate(V, B, I);
  }
  return areas;
}
