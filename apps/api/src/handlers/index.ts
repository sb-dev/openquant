// The handler registry: route id to implementation. Every route of the manifest that the API host serves has exactly one
// entry (a test checks it both ways), so no route answers "not implemented".

import {
  agentResultRoute,
  artefactRoute,
  claimRoute,
  evaluationSubmissionRoute,
  gateReportRoute,
  inputRoute,
  lateAgentResult,
  retrievalResultRoute,
  validationResultRoute,
} from './attempts.ts';
import { authToken } from './auth-token.ts';
import { applyCommand, showCommand } from './commands.ts';
import type { Handler, LateHandler } from './context.ts';
import {
  runMetrics,
  runResult,
  showDecisions,
  showFindings,
  showGates,
  showJob,
  showLineage,
  showMission,
  showPlan,
  showTrials,
} from './reads.ts';
import { recordRelease } from './releases.ts';
import { systemIdentity } from './system-identity.ts';

export const handlers: Readonly<Record<string, Handler>> = {
  'auth.token': authToken,
  'system.identity': systemIdentity,
  'releases.record': recordRelease,
  'research-profiles.register': applyCommand,
  'cohort-policies.register': applyCommand,
  'budgets.register': applyCommand,
  'seeds.register': applyCommand,
  'missions.create': applyCommand,
  'missions.run-now': applyCommand,
  'missions.cancel': applyCommand,
  'missions.show': showMission,
  'missions.plan': showPlan,
  'missions.lineage': showLineage,
  'missions.trials': showTrials,
  'missions.findings': showFindings,
  'missions.gates': showGates,
  'missions.decisions': showDecisions,
  'commands.show': showCommand,
  'runs.metrics': runMetrics,
  'runs.result': runResult,
  'jobs.show': showJob,
  'attempts.claim': claimRoute,
  'attempts.input': inputRoute,
  'attempts.artefact': artefactRoute,
  'attempts.retrieval-result': retrievalResultRoute,
  'attempts.validation-result': validationResultRoute,
  'attempts.evaluation-submission': evaluationSubmissionRoute,
  'attempts.gate-report': gateReportRoute,
  'attempts.agent-result': agentResultRoute,
};

/**
 * The routes that do something with a submission from an attempt whose lease ended, besides the refusal: the agent
 * result settles the UNRECONCILED reservation of the attempt from the usage that it carries.
 */
export const lateSubmissions: Readonly<Record<string, LateHandler>> = {
  'attempts.agent-result': lateAgentResult,
};
