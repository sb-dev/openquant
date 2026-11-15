// @openquant/agents: the proposer and critic role modules (OQ-03 sections 3 and 4).
//
// A static registry of two role modules, pure request assembly and result parsing, the dispatch checks that
// agent-dispatch/1 cannot make, and the behaviour bundle that binds the instructions. This module runs in Workers
// and in the Node agent runner: it imports no Node module and reads no filesystem. The bundle content and its hash
// come from a module that tools/generate.ts builds from bundle.manifest.json.

export {
  BUNDLE_HASH,
  BUNDLE_ID,
  BUNDLE_VERSION,
  DERIVED,
  FILES,
  MANIFEST_TEXT,
  PROCEDURES,
  RESULT_SCHEMAS,
  SUPPLIED_METHODS,
} from '../dist/generated/bundle.ts';
export {
  type Assembly,
  assembleCritiqueRequest,
  assembleFormulationRequest,
  type CritiqueInput,
  type FormulationInput,
  type Refusal,
  type RefusalCode,
  type RequestContractName,
  verifyRequest,
} from './assemble.ts';
export {
  DIAGNOSTIC_LIMIT,
  type Malformed,
  type MalformedReason,
  parseRole,
  ROLE_BODY_LIMIT,
  type RoleContractName,
  type RoleParse,
} from './contract.ts';
export { checkDispatch, type DispatchRequest, type DispatchViolation, type DispatchViolationCode } from './dispatch.ts';
export { datesInExclusions, exclusionIssues, REQUIRED_EXCLUSIONS } from './holdout.ts';
export {
  type ChangeComparison,
  classifyScope,
  compareChanges,
  computeDifference,
  DECLARED_TEXT_LIMIT,
  type DeclaredChange,
  type LeafChange,
  leafChanges,
  render,
  renderValue,
  type Scope,
  type ScopeResult,
  strategyBody,
} from './leaf-diff.ts';
export { type CritiqueParse, type LabelledFinding, parseCritiqueResult } from './parse-critique.ts';
export {
  type Blocker,
  type BlockerCode,
  type FormulationParse,
  parseFormulationResult,
  type RevisionFacts,
} from './parse-formulation.ts';
export {
  type ExecutorProfileEntry,
  type KnowledgeCutoff,
  profiles,
  profilesForRole,
  type RequestContract,
  type ResultContract,
  type Role,
  registry,
  type SkillEntry,
  type SkillId,
  skillEntry,
  skillForRole,
} from './registry.ts';
export type {
  StrategyCritiqueRequest,
  StrategyCritiqueResult,
  StrategyFormulationRequest,
  StrategyFormulationResult,
} from './types.ts';
