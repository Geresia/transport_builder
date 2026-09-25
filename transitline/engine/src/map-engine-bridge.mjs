import { commissionProject, decommissionService, suspendCommissionedService } from "./management/integration.mjs";

function copy(value) {
  return structuredClone(value);
}

export function createMapEngineBridge(game, operationalState) {
  return Object.freeze({
    submitPlan(planGeometry, technicalProfileId) {
      const record = game.submitPlan(planGeometry, technicalProfileId);
      return copy({
        planRecordId: record.id,
        planId: record.planId,
        version: record.version,
        status: record.status,
        assessment: record.assessment,
      });
    },

    approvePlan(planRecordId) {
      const record = game.approvePlan(planRecordId);
      return copy({ planRecordId: record.id, status: record.status, approvedAt: record.approvedAt });
    },

    createProject(planRecordId) {
      const project = game.createProjectFromPlan(planRecordId);
      return copy(projectSummary(project));
    },

    contractProject(projectId) {
      return copy(game.contractProject(projectId));
    },

    suspendProject(projectId, reason) {
      return copy(projectSummary(game.suspendProject(projectId, reason)));
    },

    resumeProject(projectId) {
      return copy(projectSummary(game.resumeProject(projectId)));
    },

    commission(input) {
      const result = commissionProject(game, operationalState, input);
      return copy({ lineId: result.line.id, stationIds: result.stationIds, trackSegmentIds: result.trackSegmentIds });
    },

    suspendService(serviceId, suspended = true) {
      return suspendCommissionedService(game, operationalState, serviceId, suspended);
    },

    decommissionService(serviceId) {
      return decommissionService(game, operationalState, serviceId);
    },

    getPlan(planRecordId) {
      const record = game.requirePlan(planRecordId);
      const project = record.projectId ? game.projects.find((item) => item.id === record.projectId) : null;
      return copy({
        planRecordId: record.id,
        planId: record.planId,
        version: record.version,
        status: record.status,
        assessment: record.assessment,
        project: project ? projectSummary(project) : null,
      });
    },

    getProjectOverlay(projectId) {
      const project = game.requireProject(projectId);
      const taskProgress = Object.fromEntries(project.tasks.map((task) => [task.id, task.progress]));
      return copy({
        projectId: project.id,
        planId: project.planId,
        status: project.status,
        progress: project.progress,
        delayMonths: project.delayMonths,
        taskProgress,
        stations: project.planGeometry.stationCandidates.map((station) => ({
          id: station.id,
          location: station.location,
          status: project.status,
        })),
        segments: project.planGeometry.segments.map((segment, index) => ({
          id: `${project.id}:segment-${index + 1}`,
          from: segment.from,
          to: segment.to,
          status: project.status,
          structure: segment.structureHint,
        })),
      });
    },
  });
}

function projectSummary(project) {
  return {
    projectId: project.id,
    planId: project.planId,
    planVersion: project.planVersion,
    status: project.status,
    progress: project.progress,
    estimate: project.estimate,
    delayMonths: project.delayMonths,
    commissionedLineId: project.commissionedLineId ?? null,
  };
}
