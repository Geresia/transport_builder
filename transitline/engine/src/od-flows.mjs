// Measured home->work destination choice from a pack's optional `od.json` (manifest.files.od).
// od.json is keyed by 5-digit municipality code; stations are demand points, so codes are mapped to point ids
// through each point's `code` / `jisCode`. Own-municipality flows, `unknown` and `out` are left out: at this
// resolution a station cannot serve trips that never leave its own point, and out-of-region trips have no station.
export function odRowsByStation(demand, od) {
  const idByCode = new Map();
  for (const p of demand.points) {
    const code = p.jisCode !== undefined ? String(p.jisCode).slice(0, 5) : p.code;
    if (code !== undefined) idByCode.set(String(code), p.id);
  }
  const rows = new Map();
  for (const [code, r] of Object.entries(od.origins ?? {})) {
    const from = idByCode.get(code);
    if (from === undefined) continue;
    const row = [];
    let total = 0;
    for (const [destCode, n] of Object.entries(r.dest ?? {})) {
      const to = idByCode.get(destCode);
      if (to === undefined || to === from || !(n > 0)) continue;
      row.push({ id: to, weight: n });
      total += n;
    }
    if (total > 0) rows.set(from, { row, total });
  }
  return rows;
}
