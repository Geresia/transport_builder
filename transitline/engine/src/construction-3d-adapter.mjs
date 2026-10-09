// B21-P2 optional-client handshake. This is not a Unity dependency: hosts can
// use it before loading a WebGL build and can always fall back to the 2D game.

export const CONSTRUCTION_3D_ADAPTER_PROTOCOL = "transitline.construction-3d-adapter/1";
export const CONSTRUCTION_3D_ADAPTER_CAPABILITIES = Object.freeze(["scene-manifest-v1", "change-set-v1"]);
const clone = (value) => structuredClone(value);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const compare = (a, b) => String(a).localeCompare(String(b));

export function assessConstruction3dClient(client, { requiredCapabilities = CONSTRUCTION_3D_ADAPTER_CAPABILITIES } = {}) {
  const required = [...new Set(requiredCapabilities ?? [])].filter((value) => typeof value === "string").sort(compare);
  if (client === null || client === undefined) return { schema: CONSTRUCTION_3D_ADAPTER_PROTOCOL, contractVersion: 1, status: "unavailable", usable: false, missingCapabilities: required, warnings: ["3d-client-not-provided"], fallback: "2d-only" };
  if (!client || typeof client !== "object" || Array.isArray(client)) return { schema: CONSTRUCTION_3D_ADAPTER_PROTOCOL, contractVersion: 1, status: "invalid", usable: false, missingCapabilities: required, warnings: ["3d-client-invalid"], fallback: "2d-only" };
  const warnings = [];
  if (client.protocol !== CONSTRUCTION_3D_ADAPTER_PROTOCOL) warnings.push("3d-client-protocol-mismatch");
  if (client.contractVersion !== 1) warnings.push("3d-client-contract-version-mismatch");
  const capabilities = Array.isArray(client.capabilities) ? [...new Set(client.capabilities.filter((value) => typeof value === "string"))].sort(compare) : [];
  if (!Array.isArray(client.capabilities)) warnings.push("3d-client-capabilities-unknown");
  const missingCapabilities = required.filter((capability) => !capabilities.includes(capability));
  if (missingCapabilities.length) warnings.push("3d-client-capability-missing");
  const status = warnings.some((warning) => warning.includes("protocol") || warning.includes("version")) ? "incompatible" : missingCapabilities.length ? "limited" : "ready";
  return { schema: CONSTRUCTION_3D_ADAPTER_PROTOCOL, contractVersion: 1, status, usable: status === "ready", clientId: text(client.clientId), clientVersion: text(client.clientVersion), capabilities, missingCapabilities, warnings, fallback: "2d-only" };
}

// A host keeps only the chosen client identity and scene/change-set references.
// Binary/WebGL runtime state is intentionally absent from this serializable doc.
export function construction3dSessionDocument({ client, selectedSourceIds = null, selectedChangeSetId = null } = {}) {
  const handshake = assessConstruction3dClient(client);
  const sources = selectedSourceIds === null || selectedSourceIds === undefined ? null : Array.isArray(selectedSourceIds) ? [...new Set(selectedSourceIds.filter((value) => typeof value === "string" && value.trim()))].sort(compare) : null;
  return { schema: "transitline.construction-3d-session/1", contractVersion: 1, client: handshake.clientId === null ? null : { clientId: handshake.clientId, clientVersion: handshake.clientVersion }, selectedSourceIds: sources, selectedChangeSetId: text(selectedChangeSetId), clientStatus: handshake.status, fallback: "2d-only" };
}
