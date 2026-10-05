// What every independent map mount shares: an overlay canvas, a panel and a <style> the mount makes itself (so main.mjs /
// index.html / style.css stay untouched), the pointer -> lon/lat conversion, and a localStorage-backed document store that
// never throws and never applies another pack's save. Pure browser plumbing: nothing here knows any map fact, and it does
// not touch any engine state, money or clock.

export const clone = (v) => structuredClone(v);
export const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// a list from whatever shape a host getter hands over: a list, one object, or an export that holds the list under `key`
export const arr = (v, key) => (Array.isArray(v) ? v : v && key && Array.isArray(v[key]) ? v[key] : v ? [v] : []);

// The nearest point of a screen-space polyline to a point: distance, the segment, how far along that segment (0..1) and the point.
export function nearestOnScreenLine(pts, p) {
  let best = null;
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    const d = Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
    if (!best || d < best.d) best = { d, segment: i - 1, t };
  }
  return best;
}

// canvas: the map canvas; projection.toScreen([lon, lat], w, h) -> [x, y]; pack.manifest.origin: a lon/lat the inverse is built around.
export function createShell({ canvas, projection, pack, styleId, css, panelClass, layerZ = 6, panelZ = 7 }) {
  const doc = canvas.ownerDocument;
  const win = doc.defaultView;
  if (!doc.getElementById(styleId)) { const s = doc.createElement("style"); s.id = styleId; s.textContent = css; doc.head.append(s); }
  const layer = doc.createElement("canvas");
  layer.style.cssText = `position:fixed;pointer-events:none;z-index:${layerZ}`;
  (canvas.parentNode ?? doc.body).append(layer);
  const box = doc.createElement("div");
  box.className = panelClass;
  box.style.zIndex = String(panelZ);
  box.hidden = true;
  doc.body.append(box);
  const screen = (loc) => projection.toScreen(loc, canvas.width, canvas.height);
  const origin = pack.manifest.origin;
  const lonLat = (x, y) => { // toScreen is affine in lon/lat, so its inverse follows from two sample points
    const o = screen(origin);
    const u = screen([origin[0] + 1, origin[1] + 1]);
    return [origin[0] + (x - o[0]) / (u[0] - o[0]), origin[1] + (y - o[1]) / (u[1] - o[1])];
  };
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const pointer = (ev) => { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  const button = (parent, label, fn, cls = "") => { const b = el("button", cls, label); b.type = "button"; b.addEventListener("click", (e) => { e.stopPropagation?.(); fn(); }); parent.append(b); return b; };
  // places the overlay over the canvas; returns the key of what it covers so the caller can skip a redraw
  const fit = (visible) => {
    const rect = canvas.getBoundingClientRect();
    Object.assign(layer.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, display: visible ? "" : "none" });
    if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height; }
    return `${canvas.width}|${canvas.height}|${rect.left}|${rect.top}`;
  };
  // pointer (capture, so the map's own handler does not also see the click), double click, keys, resize and an optional timer
  const attach = ({ onPointerDown, onDblClick, onKey, refresh, autoRefreshMs }) => {
    canvas.addEventListener("pointerdown", onPointerDown, true);
    canvas.addEventListener("dblclick", onDblClick);
    win.addEventListener("keydown", onKey);
    win.addEventListener("resize", refresh);
    const timer = autoRefreshMs > 0 ? win.setInterval(refresh, autoRefreshMs) : null;
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown, true);
      canvas.removeEventListener("dblclick", onDblClick);
      win.removeEventListener("keydown", onKey);
      win.removeEventListener("resize", refresh);
      if (timer !== null) win.clearInterval(timer);
      layer.remove();
      box.remove();
    };
  };
  const typing = () => ["INPUT", "SELECT", "TEXTAREA"].includes(doc.activeElement?.tagName);
  return { doc, win, layer, box, screen, lonLat, el, pointer, button, fit, attach, typing };
}

// The saved document of one mount: read once, written after every edit. Reading applies `restore` (which refuses another pack's
// save and flags a pack version change); a blocked or full storage is a note, never an exception.
export function createStore({ win, key, pack, restore, serialize, notes }) {
  let text = null;
  try { text = win.localStorage.getItem(key); } catch { /* storage may be blocked: start empty */ }
  const first = restore(text, pack);
  notes.push(...first.warnings);
  return {
    key, doc: first.doc,
    save(doc, code) { try { win.localStorage.setItem(key, serialize(doc)); return true; } catch { notes.push({ code }); return false; } },
  };
}
