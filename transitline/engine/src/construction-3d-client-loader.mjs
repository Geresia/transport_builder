// B21-P3 host transport loader.  It deliberately knows no Unity binary or
// renderer implementation.  A host supplies a narrowly scoped transport only
// after an explicit player action; every rejected message closes that transport
// and retains the authoritative JavaScript game in 2D-only mode.
import { assessConstruction3dClientProposal, parseConstruction3dClientEnvelope, prepareConstruction3dClientLaunch } from "./construction-3d-client-envelope.mjs";
import { CONSTRUCTION_3D_PREFLIGHT_SCHEMA } from "./construction-3d-preflight.mjs";

export const CONSTRUCTION_3D_CLIENT_LOADER_SCHEMA = "transitline.construction-3d-client-loader/1";
const clone = (value) => structuredClone(value);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function emptyState({ sessionId, expectedOrigin, reason = null } = {}) {
  return {
    schema: CONSTRUCTION_3D_CLIENT_LOADER_SCHEMA, contractVersion: 1,
    sessionId: text(sessionId), expectedOrigin: text(expectedOrigin), status: "2d-only",
    fallback: "2d-only", reason, launch: null, proposal: null,
    notPerformed: ["unity-load", "render", "change-set-apply", "construction-approval", "cash", "ledger", "demand", "clock"],
  };
}

function validPreflight(value) {
  return isObject(value) && value.schema === CONSTRUCTION_3D_PREFLIGHT_SCHEMA && value.contractVersion === 1;
}

function validTransport(value) {
  return isObject(value) && typeof value.send === "function" && typeof value.subscribe === "function" && typeof value.close === "function";
}

// Concrete browser transport for a pre-approved Unity WebGL URL.  It never
// uses a wildcard origin: both the build URL and inbound message source must
// match the host-supplied expected origin and iframe window exactly.
export function createConstruction3dIframeTransport({ url, expectedOrigin, container, hostWindow = globalThis.window, documentRef = globalThis.document } = {}) {
  const origin = text(expectedOrigin); const source = text(url);
  if (!origin) throw new Error("construction-3d-iframe-expected-origin-required");
  if (!source) throw new Error("construction-3d-iframe-url-required");
  if (!container || typeof container.append !== "function") throw new Error("construction-3d-iframe-container-required");
  if (!hostWindow || typeof hostWindow.addEventListener !== "function" || typeof hostWindow.removeEventListener !== "function") throw new Error("construction-3d-iframe-window-required");
  if (!documentRef || typeof documentRef.createElement !== "function") throw new Error("construction-3d-iframe-document-required");
  let parsed; let expected;
  try { parsed = new URL(source); expected = new URL(origin); } catch { throw new Error("construction-3d-iframe-url-invalid"); }
  if (parsed.origin !== expected.origin) throw new Error("construction-3d-iframe-origin-mismatch");
  const iframe = documentRef.createElement("iframe");
  iframe.className = "construction-3d-client-frame";
  iframe.title = "Optional construction 3D client";
  iframe.referrerPolicy = "no-referrer";
  iframe.src = parsed.href;
  container.append(iframe);
  let listener = null; let closed = false;
  const message = (event) => {
    if (closed || event?.source !== iframe.contentWindow) return;
    listener?.({ origin: event.origin, data: event.data });
  };
  hostWindow.addEventListener("message", message);
  return {
    send(envelope) {
      if (closed || !iframe.contentWindow || typeof iframe.contentWindow.postMessage !== "function") throw new Error("construction-3d-iframe-unavailable");
      iframe.contentWindow.postMessage(clone(envelope), expected.origin);
    },
    subscribe(next) {
      if (typeof next !== "function") throw new Error("construction-3d-iframe-listener-required");
      listener = next; return () => { if (listener === next) listener = null; };
    },
    close() {
      if (closed) return;
      closed = true; listener = null; hostWindow.removeEventListener("message", message);
      if (typeof iframe.remove === "function") iframe.remove();
    },
    frame: iframe,
  };
}

export function construction3dIframeTransportFactory(options = {}) {
  return ({ expectedOrigin }) => createConstruction3dIframeTransport({ ...options, expectedOrigin });
}

// The transport boundary is intentionally injectable.  A WebGL iframe,
// desktop bridge, or test double may implement {send, subscribe, close}; this
// module neither selects nor loads a Unity binary.
export function createConstruction3dClientLoader({ pack, getPreflight, sessionId, expectedOrigin, transportFactory, onChange = null, onProposal = null, schedule = setTimeout, cancel = clearTimeout, handshakeTimeoutMs = 15_000 } = {}) {
  if (typeof getPreflight !== "function") throw new Error("construction-3d-loader-preflight-getter-required");
  const id = text(sessionId); const origin = text(expectedOrigin);
  if (!id) throw new Error("construction-3d-loader-session-id-required");
  if (!origin) throw new Error("construction-3d-loader-expected-origin-required");
  if (typeof transportFactory !== "function") throw new Error("construction-3d-loader-transport-factory-required");
  if (!Number.isInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1) throw new Error("construction-3d-loader-timeout-invalid");
  let state = emptyState({ sessionId: id, expectedOrigin: origin });
  let transport = null; let unsubscribe = null; let timer = null; let preflight = null; let handshake = null;

  const emit = () => { const output = clone(state); if (typeof onChange === "function") onChange(clone(output)); return output; };
  const set = (next) => { if (same(state, next)) return clone(state); state = clone(next); return emit(); };
  const release = ({ close = true } = {}) => {
    if (timer !== null) { cancel(timer); timer = null; }
    if (typeof unsubscribe === "function") unsubscribe();
    unsubscribe = null;
    if (close && transport) { try { transport.close(); } catch { /* Close is best effort only. */ } }
    transport = null; preflight = null; handshake = null;
  };
  const fail = (reason, extra = {}) => { release(); return set({ ...emptyState({ sessionId: id, expectedOrigin: origin, reason }), ...extra, fallback: "2d-only" }); };
  const current = () => clone(state);

  const receive = (message) => {
    if (!transport) return current();
    if (!isObject(message) || text(message.origin) !== origin) return fail("transport-origin-mismatch");
    const kind = message?.data?.kind;
    if (state.status === "connecting") {
      const parsed = parseConstruction3dClientEnvelope(message.data, { sessionId: id, kinds: ["handshake"] });
      if (!parsed.accepted) return fail(`handshake:${parsed.reason}`);
      handshake = clone(parsed.envelope);
      const launch = prepareConstruction3dClientLaunch({ pack, preflight, handshake: parsed.envelope, sessionId: id });
      if (!launch.ready || !launch.sceneEnvelope) return fail("handshake-rejected", { launch: clone(launch) });
      try { transport.send(clone(launch.sceneEnvelope)); } catch { return fail("scene-send-failed", { launch: clone(launch) }); }
      if (timer !== null) { cancel(timer); timer = null; }
      return set({ ...emptyState({ sessionId: id, expectedOrigin: origin }), status: "connected", fallback: null, reason: null, launch: clone(launch) });
    }
    if (state.status !== "connected") return current();
    if (kind === "close") { const parsed = parseConstruction3dClientEnvelope(message.data, { sessionId: id, kinds: ["close"] }); return parsed.accepted ? fail("client-closed") : fail(`close:${parsed.reason}`); }
    const proposal = assessConstruction3dClientProposal({ pack, preflight, handshake, proposal: message.data, sessionId: id });
    if (!proposal.applicable) return fail("proposal-rejected", { launch: clone(state.launch), proposal: clone(proposal) });
    const next = { ...state, proposal: clone(proposal) };
    set(next);
    if (typeof onProposal === "function") onProposal(clone(proposal));
    return current();
  };

  const api = {
    open() {
      if (transport) return current();
      try { preflight = getPreflight(); } catch (error) { return fail(`preflight:${error instanceof Error ? error.message : String(error)}`); }
      if (!validPreflight(preflight)) return fail("preflight-invalid");
      handshake = null;
      let nextTransport;
      try { nextTransport = transportFactory({ sessionId: id, expectedOrigin: origin }); } catch (error) { return fail(`transport-open:${error instanceof Error ? error.message : String(error)}`); }
      if (!validTransport(nextTransport)) { try { nextTransport?.close?.(); } catch { /* no host effect */ } return fail("transport-invalid"); }
      transport = nextTransport;
      try { unsubscribe = transport.subscribe(receive); } catch { return fail("transport-subscribe-failed"); }
      timer = schedule(() => { if (state.status === "connecting") fail("handshake-timeout"); }, handshakeTimeoutMs);
      return set({ ...emptyState({ sessionId: id, expectedOrigin: origin }), status: "connecting", reason: null });
    },
    receive,
    close(reason = "player-closed") { return fail(text(reason) ?? "player-closed"); },
    output: current,
    destroy() { return fail("host-destroyed"); },
  };
  return api;
}

const el = (doc, tag, props = {}, ...children) => { const node = doc.createElement(tag); Object.assign(node, props); node.append(...children); return node; };

// A minimal host surface. The button is the only action that opens a transport.
export function mountConstruction3dClientLoader({ container, ...options } = {}) {
  if (!container) throw new Error("construction-3d-loader-container-required");
  const doc = container.ownerDocument ?? document;
  let loader = null;
  const render = () => {
    const out = loader.output();
    const notice = el(doc, "p", { className: "construction-3d-loader-notice", textContent: "Optional construction 3D. The 2D game remains authoritative." });
    const state = el(doc, "div", { className: "construction-3d-loader-state", textContent: `Client state: ${out.status}` });
    const reason = el(doc, "div", { className: "construction-3d-loader-reason", textContent: out.reason === null ? "Reason: none" : `Reason: ${out.reason}` });
    const button = el(doc, "button", { className: "construction-3d-loader-open", textContent: out.status === "connected" ? "Close 3D client" : "Open optional 3D client" });
    button.addEventListener("click", () => { if (loader.output().status === "connected") loader.close(); else loader.open(); render(); });
    container.replaceChildren(notice, state, reason, button);
  };
  const suppliedOnChange = options.onChange;
  loader = createConstruction3dClientLoader({ ...options, onChange: (output) => { suppliedOnChange?.(output); render(); } });
  render();
  return { ...loader, refresh() { render(); return loader.output(); } };
}
