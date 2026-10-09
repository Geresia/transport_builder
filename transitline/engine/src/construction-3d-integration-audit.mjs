// B24 read-only end-to-end audit: joins the B20 program reference and optional
// B21-B23 artifacts. It never opens a client, applies a change set, or changes
// campaign/operational state.

import { assessConstruction3dClient } from "./construction-3d-adapter.mjs";
import { assessConstruction3dChangeSet } from "./construction-3d-exchange.mjs";
import { assessConstruction3dSpatialReview } from "./construction-3d-spatial-review.mjs";

export const CONSTRUCTION_3D_INTEGRATION_AUDIT_SCHEMA = "transitline.construction-3d-integration-audit/1";
const clone = (value) => structuredClone(value);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const compare = (a, b) => String(a).localeCompare(String(b));

export function buildConstruction3dIntegrationAudit({ pack, client = null, campaignPrograms = [], scene = null, changeSet = null, review = null, currentSources = [] } = {}) {
  const packId = text(pack?.manifest?.id ?? pack?.id);
  const clientResult = assessConstruction3dClient(client);
  const blockers = []; const warnings = [];
  if (!packId) blockers.push("pack-id-missing");
  const programs = (campaignPrograms ?? []).map((program) => ({ campaignProgramId: program?.id ?? null, programId: program?.programId ?? null, status: program?.status ?? null, geometryStatus: program?.geometry?.status ?? null })).filter((program) => program.campaignProgramId && program.programId).sort((a, b) => compare(a.campaignProgramId, b.campaignProgramId));
  if (scene === null) warnings.push("scene-not-provided");
  else if (scene?.packId !== packId) blockers.push("scene-other-pack");
  const coordinates = scene?.coordinates ?? null;
  const change = changeSet === null ? null : assessConstruction3dChangeSet(changeSet, { pack, coordinates, currentSources });
  const spatialReview = review === null ? null : assessConstruction3dSpatialReview(review, { pack, currentSources });
  if (change && !change.applicable) blockers.push(...change.blockers.map((entry) => `change-set:${entry}`));
  if (spatialReview && !spatialReview.applicable) blockers.push(...spatialReview.blockers.map((entry) => `review:${entry}`));
  if (!clientResult.usable) warnings.push(`3d-client-${clientResult.status}`);
  return { schema: CONSTRUCTION_3D_INTEGRATION_AUDIT_SCHEMA, contractVersion: 1, packId: packId ?? null,
    client: clone(clientResult), programs, scene: scene === null ? null : { schema: scene?.schema ?? null, packId: scene?.packId ?? null, sourceCount: Array.isArray(scene?.sources) ? scene.sources.length : null },
    changeSet: change, spatialReview, applicable: blockers.length === 0, blockers: [...new Set(blockers)].sort(compare), warnings: [...new Set(warnings)].sort(compare), fallback: clientResult.usable ? null : "2d-only",
    notComputed: ["construction-approval", "cost", "schedule", "demand", "passengers", "ledger", "operations"] };
}
