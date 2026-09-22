// Fetches and parses a CityPack (docs/citypack-format.md) over http(s).
// `packPath` is resolved relative to the document, not this module — e.g.
// "../packs/example-radial" when this page is served from engine/index.html
// with packs/ as a sibling. file:// won't work: fetch() refuses it.

// `compressed` is manifest.compressed: files that also exist as a gzip sibling (x.json.gz) are
// fetched compressed and inflated here; a missing/unreadable .gz falls back to the plain file.
async function fetchJson(url, compressed = {}) {
  const name = String(url).split("/").pop();
  if (compressed[name]) {
    try {
      const gz = await fetch(`${url}.gz`);
      if (gz.ok) return await new Response(gz.body.pipeThrough(new DecompressionStream("gzip"))).json();
    } catch { /* fall back to plain */ }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

export async function loadPack(packPath) {
  const base = packPath.endsWith("/") ? packPath : `${packPath}/`;
  const manifest = await fetchJson(new URL(`${base}manifest.json`, document.baseURI));
  if (manifest.formatVersion !== 1) {
    throw new Error(`unsupported manifest.formatVersion: ${manifest.formatVersion}`);
  }

  const demandRel = manifest.files?.demand;
  if (!demandRel) throw new Error("manifest.files.demand is missing");
  const demand = await fetchJson(new URL(demandRel, new URL(base, document.baseURI)), manifest.compressed);
  if (demand.formatVersion !== 1) {
    throw new Error(`unsupported demand.formatVersion: ${demand.formatVersion}`);
  }
  if (demand.model !== "gravity" && demand.model !== "matrix") {
    throw new Error(`unsupported demand.model '${demand.model}'`);
  }

  // Optional measured O/D (od.json). A missing or unreadable file must not stop the pack loading: gravity still works.
  let od = null;
  if (manifest.files?.od) {
    try { od = await fetchJson(new URL(manifest.files.od, new URL(base, document.baseURI)), manifest.compressed); }
    catch (e) { console.warn("od.json not loaded, using gravity destinations:", e.message); }
  }

  // Optional real-world starting network (existing-network.json). A missing or unreadable file
  // must not stop the pack loading: the game is equally playable starting from a blank map.
  let existingNetwork = null;
  if (manifest.files?.existingNetwork) {
    try { existingNetwork = await fetchJson(new URL(manifest.files.existingNetwork, new URL(base, document.baseURI)), manifest.compressed); }
    catch (e) { console.warn("existing-network.json not loaded, starting blank:", e.message); }
  }

  return { manifest, demand, od, existingNetwork };
}
