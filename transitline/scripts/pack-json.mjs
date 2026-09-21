// Read a pack JSON file whether stored as plain `x.json` or gzip `x.json.gz` (see pack-compress.mjs).
import fs from "fs";
import zlib from "zlib";
export function readPackJson(path) {
  if (fs.existsSync(path)) return JSON.parse(fs.readFileSync(path, "utf8"));
  if (fs.existsSync(path + ".gz")) return JSON.parse(zlib.gunzipSync(fs.readFileSync(path + ".gz")).toString("utf8"));
  throw new Error(`${path}(.gz) not found`);
}
