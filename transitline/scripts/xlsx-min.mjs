// Minimal zip + xlsx reader, no dependency (zip central directory + raw inflate). Entries are Buffers so zips can nest.
// Strings are returned exactly as stored: some government sheets append a furigana reading to a label ("旅館リョカン").
import zlib from "node:zlib";

export function unzip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a zip file");
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const files = {};
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nl);
    const lho = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = buf.subarray(lho, lho + csize);
    files[name] = () => (method === 0 ? data : zlib.inflateRawSync(data));
    p += 46 + nl + xl + cl;
  }
  return files;
}

// -> { sheetName: [ {colLetter: value} ] }; `only` limits which sheets are parsed (the big ones cost real time)
export function readXlsx(buf, only) {
  const z = unzip(buf), text = (f) => z[f]().toString("utf8");
  const names = [...text("xl/workbook.xml").matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => m[1]);
  const strs = z["xl/sharedStrings.xml"] ? [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join("")) : [];
  const out = {};
  names.forEach((nm, i) => {
    if (only && !only.includes(nm)) return;
    out[nm] = [...text(`xl/worksheets/sheet${i + 1}.xml`).matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
      const o = {};
      for (const c of r[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const v = (c[3] || "").match(/<v>([\s\S]*?)<\/v>/);
        if (v) o[c[1]] = /t="s"/.test(c[2]) ? strs[+v[1]] : v[1];
      }
      return o;
    });
  });
  return out;
}
