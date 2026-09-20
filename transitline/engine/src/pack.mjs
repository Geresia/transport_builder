// Fetches and parses a CityPack (docs/citypack-format.md) over http(s).
// `packPath` is resolved relative to the document, not this module — e.g.
// "../packs/example-radial" when this page is served from engine/index.html
// with packs/ as a sibling. file:// won't work: fetch() refuses it.

async function fetchJson(url) {
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
  const demand = await fetchJson(new URL(demandRel, new URL(base, document.baseURI)));
  if (demand.formatVersion !== 1) {
    throw new Error(`unsupported demand.formatVersion: ${demand.formatVersion}`);
  }
  if (demand.model !== "gravity" && demand.model !== "matrix") {
    throw new Error(`unsupported demand.model '${demand.model}'`);
  }

  return { manifest, demand };
}
