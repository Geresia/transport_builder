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

  // Optional measured school-commute O/D (od-school.json), same shape as od.json. Folded into the same
  // demand model as od.json (see demand-engine.mjs) - the engine has no separate "student" trip kind.
  let odSchool = null;
  if (manifest.files?.odSchool) {
    try { odSchool = await fetchJson(new URL(manifest.files.odSchool, new URL(base, document.baseURI)), manifest.compressed); }
    catch (e) { console.warn("od-school.json not loaded:", e.message); }
  }

  // Optional real-world starting network (existing-network.json). A missing or unreadable file
  // must not stop the pack loading: the game is equally playable starting from a blank map.
  let existingNetwork = null;
  if (manifest.files?.existingNetwork) {
    try { existingNetwork = await fetchJson(new URL(manifest.files.existingNetwork, new URL(base, document.baseURI)), manifest.compressed); }
    catch (e) { console.warn("existing-network.json not loaded, starting blank:", e.message); }
  }

  // Optional construction/site-design geometry. These are gameplay collision layers, not merely
  // visual basemap tiles. Failure remains non-fatal, but callers must then preserve unknown/null.
  let obstacles = null;
  if (manifest.files?.obstacles) {
    try { obstacles = await fetchJson(new URL(manifest.files.obstacles, new URL(base, document.baseURI)), manifest.compressed); }
    catch (e) { console.warn("obstacles.json not loaded; building collisions remain unknown:", e.message); }
  }
  let barriers = null;
  if (manifest.files?.barriers) {
    try { barriers = await fetchJson(new URL(manifest.files.barriers, new URL(base, document.baseURI)), manifest.compressed); }
    catch (e) { console.warn("barriers.json not loaded; water collisions remain unknown:", e.message); }
  }

  return { manifest, demand, od, odSchool, existingNetwork, obstacles, barriers };
}
