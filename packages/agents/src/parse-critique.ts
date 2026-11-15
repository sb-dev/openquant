// Result parsing of the critic role module (OQ-03 section 4).
//
// A critic result is a possibly empty list of typed findings. Parsing checks structure and reference membership: a
// cited method must be supplied, an evidence reference must come from the request, and each pointer must name an
// element of the registered subject. It labels every finding the model returned `model_judgement`: only reviewed
// skill or host code records `deterministic_check`, and the critic model does not set `finding_source`. The critic
// cannot approve, close or rewrite anything: the schema has no field for it, and a stray field is malformed.
// The registered cohort policy assigns treatment later (OQ-02 section 3.6); parsing assigns none.
//
// Worker-safe: no Node module.

import { type Malformed, malformed, parseRole } from './contract.ts';
import { asJson, resolvePointer } from './json.ts';
import type { CritiqueFinding, StrategyCritiqueRequest, StrategyCritiqueResult } from './types.ts';

export type LabelledFinding = CritiqueFinding & { readonly finding_source: 'model_judgement' };

export type CritiqueParse =
  | {
      readonly ok: true;
      readonly value: StrategyCritiqueResult;
      readonly findings: readonly LabelledFinding[];
      /** An empty list is a valid completion and is not a pass. */
      readonly emptyIsNotPass: boolean;
    }
  | Malformed;

// Where a pointer must point for each location area that names an element of the registered version.
const AREA_ROOT: Readonly<Record<string, string>> = { contract: '/contract', definition: '/definition' };

function under(pointer: string, root: string): boolean {
  return pointer === root || pointer.startsWith(`${root}/`);
}

/** Parse the output of a critic attempt against its request. */
export function parseCritiqueResult(request: StrategyCritiqueRequest, output: string | Uint8Array): CritiqueParse {
  const parsed = parseRole('strategy-critique.result', output);
  if (!parsed.ok) return parsed;
  const { value } = parsed;
  const strategy = asJson(request.subject.strategy);
  const methods = new Set<string>(request.supplied_methods.map((item) => item.id));
  const evidence = new Set<string>(request.evidence_refs.map((item) => item.id));
  for (const [index, finding] of value.findings.entries()) {
    const at = `findings[${index}]`;
    for (const ref of finding.method_refs) {
      if (!methods.has(ref))
        return malformed('REFERENCE_INVALID', `${at}.method_refs cites ${ref}, which the request did not supply`);
    }
    for (const ref of finding.evidence_refs) {
      if (!evidence.has(ref))
        return malformed('REFERENCE_INVALID', `${at}.evidence_refs cites ${ref}, which the request does not hold`);
    }
    for (const pointer of finding.affected_elements) {
      if (!under(pointer, '/definition') || !resolvePointer(strategy, pointer).found) {
        return malformed(
          'REFERENCE_INVALID',
          `${at}.affected_elements ${pointer} is not an element of the subject definition`,
        );
      }
    }
    const root = AREA_ROOT[finding.location.area];
    const pointer = finding.location.pointer;
    if (
      root !== undefined &&
      pointer !== undefined &&
      (!under(pointer, root) || !resolvePointer(strategy, pointer).found)
    ) {
      return malformed(
        'REFERENCE_INVALID',
        `${at}.location.pointer ${pointer} is not an element of the subject ${finding.location.area}`,
      );
    }
  }
  const findings = value.findings.map(
    (finding): LabelledFinding => ({ ...finding, finding_source: 'model_judgement' }),
  );
  return { ok: true, value, findings, emptyIsNotPass: findings.length === 0 };
}
