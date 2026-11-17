// The checks that `agent-dispatch/1` does not make (OQ-03 section 4, OQ-05 section 4).
//
// The envelope is a schema. It ties the role to its skill and request contract, and this check repeats that for a
// dispatch built without the schema; the schema cannot say that the request it names is the request the host
// assembled, that its holdout exclusions equal the request's and name V and H, or that the executor profile is one
// the registry knows for the role. The runner calls this check before it starts an executor. A violation is
// a denied capability or a bundle mismatch found before the executor starts (OQ-03 section 4); the runner maps it,
// and nothing is dispatched. Worker-safe: no Node module.

import type { AgentDispatch } from '@openquant/api-contracts';
import { BUNDLE_HASH } from '../dist/generated/bundle.ts';
import { exclusionIssues } from './holdout.ts';
import { jsonEqual } from './json.ts';
import { profilesForRole, skillEntry } from './registry.ts';
import type { StrategyCritiqueRequest, StrategyFormulationRequest } from './types.ts';

export type DispatchViolationCode =
  | 'SKILL_NOT_REGISTERED'
  | 'ROLE_SKILL_MISMATCH'
  | 'REQUEST_CONTRACT_MISMATCH'
  | 'REQUEST_ARTEFACT_MISMATCH'
  | 'HOLDOUT_EXCLUSIONS_MISMATCH'
  | 'HOLDOUT_EXCLUSIONS_INVALID'
  | 'BUNDLE_HASH_MISMATCH'
  | 'CAPABILITIES_MISMATCH'
  | 'CAPABILITY_UNAVAILABLE'
  | 'PROFILE_NOT_REGISTERED'
  | 'OUTPUT_LIMIT_TOO_HIGH'
  | 'TOOLS_NOT_PERMITTED'
  | 'RESULT_ROUTE_MISMATCH';

export interface DispatchViolation {
  readonly code: DispatchViolationCode;
  readonly detail: string;
}

/** The assembled request that the dispatch names: the parsed request and the artefact that request assembly returned. */
export interface DispatchRequest {
  readonly request: StrategyFormulationRequest | StrategyCritiqueRequest;
  readonly artefact: { readonly digest: string; readonly media_type: string; readonly size_bytes: number };
}

/**
 * Check a parsed `agent-dispatch/1` against the registry, the assembled request and the bundle module. Returns every
 * violation, or an empty list when the dispatch may start an executor. It checks:
 *
 * - the skill is registered, the role is the skill's role, and the request contract is the skill's;
 * - the request artefact is the one assembly returned: digest, media type and size;
 * - the dispatch repeats the request's holdout exclusions exactly, and they name V and H;
 * - the bundle hash is the one in the bundle module, so no local text can be substituted;
 * - the required capabilities are the registry's, and each is available in the request;
 * - the executor profile is one registered for the role;
 * - the output limit is within the role result limit, no tool is granted, and the result route is the attempt's.
 */
export function checkDispatch(dispatch: AgentDispatch, assembled: DispatchRequest): DispatchViolation[] {
  const violations: DispatchViolation[] = [];
  const add = (code: DispatchViolationCode, detail: string) => violations.push({ code, detail });
  const { identity, execution, inputs } = dispatch;
  const skill = skillEntry(identity.skill.id);
  if (!skill) {
    add('SKILL_NOT_REGISTERED', `the skill ${identity.skill.id} is not in the registry`);
    return violations;
  }
  if (skill.version !== identity.skill.version) {
    add(
      'SKILL_NOT_REGISTERED',
      `the registry has version ${skill.version} of ${skill.id}, not ${identity.skill.version}`,
    );
  }
  if (!skill.roles.includes(identity.role)) {
    add('ROLE_SKILL_MISMATCH', `the skill ${skill.id} serves ${skill.roles.join(', ')}, not ${identity.role}`);
  }
  if (inputs.request.contract !== skill.request_contract) {
    add(
      'REQUEST_CONTRACT_MISMATCH',
      `the skill ${skill.id} takes ${skill.request_contract}, not ${inputs.request.contract}`,
    );
  }
  if (assembled.request.schema_version !== skill.request_contract) {
    add(
      'REQUEST_CONTRACT_MISMATCH',
      `the assembled request is ${assembled.request.schema_version}, not ${skill.request_contract}`,
    );
  }
  const named = inputs.request.artefact;
  if (named.digest !== assembled.artefact.digest)
    add('REQUEST_ARTEFACT_MISMATCH', 'the request digest is not the digest of the assembled request');
  if (named.size_bytes !== assembled.artefact.size_bytes)
    add('REQUEST_ARTEFACT_MISMATCH', 'the request size is not the size of the assembled request');
  if (named.media_type !== assembled.artefact.media_type)
    add('REQUEST_ARTEFACT_MISMATCH', 'the request media type is not the assembled one');
  if (!jsonEqual(inputs.holdout_exclusions, assembled.request.context.holdout_exclusions)) {
    add('HOLDOUT_EXCLUSIONS_MISMATCH', 'the dispatch holdout exclusions are not the exclusions of the request');
  }
  for (const issue of exclusionIssues(inputs.holdout_exclusions, assembled.request.context.evaluation_policy)) {
    add('HOLDOUT_EXCLUSIONS_INVALID', issue);
  }
  if (identity.bundle_hash !== BUNDLE_HASH) {
    add('BUNDLE_HASH_MISMATCH', 'the dispatch names another behaviour bundle than the one built into this module');
  }
  const required = [...execution.required_capabilities].sort();
  const registered = [...skill.required_capabilities].sort();
  if (JSON.stringify(required) !== JSON.stringify(registered)) {
    add('CAPABILITIES_MISMATCH', 'the required capabilities are not the capabilities of the registry entry');
  }
  for (const capability of execution.required_capabilities) {
    if (!assembled.request.context.provider_capabilities.includes(capability)) {
      add('CAPABILITY_UNAVAILABLE', `the required capability ${capability} is not available in the request`);
    }
  }
  const profile = execution.executor.profile;
  if (
    !profilesForRole(identity.role).some(
      (entry) => entry.profile.model === profile.model && entry.profile.effort === profile.effort,
    )
  ) {
    add(
      'PROFILE_NOT_REGISTERED',
      `no ${identity.role} configuration uses the profile ${profile.model} with effort ${profile.effort}`,
    );
  }
  if (execution.bounds.output_limit_bytes > skill.limits.output_bytes) {
    add(
      'OUTPUT_LIMIT_TOO_HIGH',
      `the output limit is above the ${skill.limits.output_bytes} bytes that a role result is parsed within`,
    );
  }
  if (execution.tools.length > 0) add('TOOLS_NOT_PERMITTED', 'the pilot role modules expose no agent-callable tool');
  if (dispatch.result_route !== `/v1/attempts/${identity.attempt.attempt_id}/agent-result`) {
    add('RESULT_ROUTE_MISMATCH', 'the result route is not the route of the dispatched attempt');
  }
  return violations;
}
