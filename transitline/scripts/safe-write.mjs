// Never-shrink guard for regenerated pack files. The registry's incident log has several cases where a source disappeared or a
// script misfired and a data file was silently overwritten with (almost) nothing. Scripts that rebuild a data file from an external
// source should write through this: if the new content has markedly fewer entries than what is on disk, refuse - unless the operator
// says so with ALLOW_SHRINK=1 (a genuine reduction, e.g. dropping a region on purpose).
import fs from "node:fs";

// count: (parsed JSON) -> number of entries that matter for this file (municipalities, chomes, buildings, ...)
export function writeChecked(file, text, { count, label = "entries", minRatio = 0.9 }) {
  if (fs.existsSync(file) && process.env.ALLOW_SHRINK !== "1") {
    let oldN = null;
    try { oldN = count(JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""))); } catch { /* unreadable old file: nothing to protect */ }
    const newN = count(JSON.parse(text));
    if (oldN > 0 && newN < oldN * minRatio) {
      throw new Error(`refusing to overwrite ${file}: ${label} would drop from ${oldN} to ${newN} (below ${Math.round(minRatio * 100)}%). Set ALLOW_SHRINK=1 if this is intended.`);
    }
    if (newN !== oldN) console.log(`${file}: ${label} ${oldN} -> ${newN}`);
  }
  fs.writeFileSync(file, text);
}
