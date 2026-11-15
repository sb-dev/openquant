// The offline agent suites of fixtures/agent-results, run through the real runner (OQ-03 section 6).
//
// The role-module suites in packages/agents stop at request assembly and result parsing. Here every fixture goes
// through the whole production path of the runner: the dispatch, the claim, the stored request that the runner
// verifies the way assembly builds it, the executor (a script that stands in for the pinned CLI and answers with the
// fixture's labelled synthetic response), the shared validator, the stored role output and the posted result. No model
// is called, and the fixtures stay synthetic: this proves the runner, not a model.
//
// What each fixture must give is written by hand in the fixture (`expect`, `assembly`). The runner differs from the
// role module in one documented place, and this file states it independently of the code under test: a request that
// assembly refuses is never run, the runner denies it before an executor starts. A completion with blockers, such as
// an operator outside the permitted set or a date inside a withheld window, stays a completion (OQ-03 section 3).

import { assembleCritiqueRequest, assembleFormulationRequest } from '@openquant/agents';
import { digest } from '@openquant/api-contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureFiles, readFixture } from '../../../packages/agents/dev/fixture-runner.ts';
import {
  type CritiqueRecipe,
  critiqueInput,
  type FormulationRecipe,
  formulationInput,
  responseText,
} from '../../../packages/agents/dev/world.ts';
import { sha256Text, stable } from '../../../packages/agents/test/support/oracle.ts';
import { Runner } from '../src/runner.ts';
import { type Assembled, cleanup, dispatchFor, makeWorld, storedRequest } from './support/world.ts';

afterEach(cleanup);

const files = fixtureFiles();

interface Expected {
  readonly outcome: 'completion' | 'malformed_result' | 'denied_capability';
  readonly reason?: string | undefined;
  /** The executor must not have started: not even its version was asked. */
  readonly neverStarted: boolean;
}

/** What the runner must post for a fixture, from the hand-written expectations of the fixture and the rule above. */
function expectedOf(fixture: ReturnType<typeof readFixture>): Expected {
  if (fixture.assembly?.outcome === 'refused') {
    return { outcome: 'denied_capability', reason: 'CAPABILITY_DENIED', neverStarted: true };
  }
  const expect = fixture.expect as { outcome: 'completion' | 'malformed_result'; reason?: string };
  if (expect.outcome === 'malformed_result') {
    return { outcome: 'malformed_result', reason: expect.reason, neverStarted: false };
  }
  return { outcome: 'completion', neverStarted: false };
}

/** The stored request: what assembly returned, or, for a refused case, the same document written without the refusals. */
async function storedFor(fixture: ReturnType<typeof readFixture>): Promise<Assembled<never>> {
  const critique = fixture.suite === 'strategy-critique';
  const input = critique
    ? await critiqueInput(fixture.request as CritiqueRecipe)
    : await formulationInput(fixture.request as FormulationRecipe);
  const assembly = critique
    ? await assembleCritiqueRequest(input as Parameters<typeof assembleCritiqueRequest>[0])
    : await assembleFormulationRequest(input as Parameters<typeof assembleFormulationRequest>[0]);
  if (assembly.ok) return storedRequest(assembly.request, Buffer.from(assembly.text, 'utf8')) as Assembled<never>;
  // Assembly refused it, so the API could not have stored it. The runner must still say no when it is given the bytes.
  const raw = {
    schema_version: critique ? 'strategy-critique.request/1' : 'strategy-formulation.request/1',
    context: input.context,
    subject: input.subject,
    evidence_refs: input.evidence,
    supplied_methods: [],
  };
  return storedRequest(raw, Buffer.from(stable(raw), 'utf8')) as Assembled<never>;
}

describe('the suites', () => {
  it('hold every fixture that the role-module suites hold, and a fixture with blockers stays a completion', () => {
    const fixtures = files.map((file) => readFixture(file));
    expect(fixtures.length).toBeGreaterThanOrEqual(50);
    const denied = fixtures.filter((item) => item.assembly?.outcome === 'refused').map((item) => item.id);
    expect(denied.sort()).toEqual([
      'evaluation-metrics-evidence',
      'holdout-evidence-overlap',
      'holdout-evidence-overlap',
      'holdout-validation-evidence-overlap',
      'unregistered-subject',
    ]);
    const withBlockers = fixtures.filter((item) =>
      ((item.expect as { blockers?: { code: string }[] } | undefined)?.blockers ?? []).some(
        (blocker) => blocker.code === 'OPERATOR_NOT_PERMITTED' || blocker.code === 'HOLDOUT_REFERENCE',
      ),
    );
    expect(withBlockers.map((item) => item.id).sort()).toEqual(['holdout-leak-attempt', 'operator-outside-set']);
    expect(withBlockers.map((item) => expectedOf(item).outcome)).toEqual(['completion', 'completion']);
  });
});

describe('every fixture through the real runner', () => {
  for (const file of files) {
    const fixture = readFixture(file);
    const name = `${fixture.suite}/${fixture.id}`;
    it(`${name} gives the outcome that its fixture expects`, async () => {
      const wanted = expectedOf(fixture);
      const text = wanted.neverStarted ? '{}' : await responseText(fixture);
      const world = makeWorld({ behaviour: 'result', resultText: text });
      const stored = await storedFor(fixture);
      world.api.store(stored.bytes);
      const dispatch = dispatchFor(stored, {
        role: fixture.suite === 'strategy-critique' ? 'critic' : 'proposer',
        attempt: `attempt-${fixture.id}`.slice(0, 60),
      });
      const runner = new Runner({ config: world.config, api: world.api, sleep: async () => undefined });
      expect(await runner.dispatch(dispatch, await digest(dispatch))).toEqual({ kind: 'accepted' });
      await runner.idle();

      expect(world.api.results).toHaveLength(1);
      const result = world.api.results[0];
      expect(result?.outcome.outcome).toBe(wanted.outcome);
      if (wanted.reason !== undefined) {
        expect(result?.outcome).toMatchObject({ reason: wanted.reason });
      }
      const calls = world.cli.calls();
      if (wanted.neverStarted) {
        // Denied before the executor: nothing ran, and the usage is a measured zero.
        expect(calls).toEqual([]);
        expect(result?.usage.cost).toMatchObject({ label: 'observed', amount: '0' });
        return;
      }
      // The executor was given exactly the stored request, and was paid for the run.
      expect(calls.find((call) => call.kind === 'run')?.stdinSha256).toBe(stored.artefact.digest);
      expect(result?.usage.cost).toMatchObject({ label: 'estimated' });
      if (wanted.outcome === 'completion') {
        const output = JSON.parse(text) as unknown;
        const canonical = stable(output);
        expect(result?.outcome).toMatchObject({
          output: {
            artefact: {
              digest: sha256Text(canonical),
              size_bytes: Buffer.byteLength(canonical),
              media_type: 'application/json',
            },
          },
        });
        expect(world.api.artefacts.size).toBe(1);
      } else {
        // A malformed result keeps no part of the output.
        expect(world.api.artefacts.size).toBe(0);
        expect(result?.outcome).toMatchObject({ diagnostic: expect.stringMatching(/\S/) });
      }
    });
  }
});
