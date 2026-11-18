// The display rules of the CLI (OQ-04 sections 2, 3, 5, 11; OQ-05 section 8): "none recorded" only for the
// EVALUATING -> PAPER Decision, the mode, environment, simulated account and UNKNOWN risk on every result, an unknown
// value never shown as zero, untrusted text sanitised, and every line within 80 columns.

import type { MissionView } from '@openquant/api-contracts';
import { describe, expect, it } from 'vitest';
import { ACCOUNT, displayContext, headerLines, RISK_REASON } from '../src/context.ts';
import {
  budgetLines,
  decisionsLines,
  findingsLines,
  gatesLines,
  lineageLines,
  missionLines,
  NONE_RECORDED_LINE,
  trialsLines,
} from '../src/format.ts';
import { MAX_WIDTH, safeJson, sanitize, textWidth, wrapLines } from '../src/text.ts';
import { CONTROL, type Doc, fixture, harness } from './support.ts';

const concluded = fixture('mission-view.concluded.json') as MissionView;

/** A mission just created: nothing reported yet, so most values are null. */
function freshMission(): MissionView {
  const view = structuredClone(concluded) as Doc;
  Object.assign(view, {
    status: 'CREATED',
    outcome: null,
    outcome_reason: null,
    revision: 1,
    plan_digest: null,
    started_by: null,
    started_at: null,
    concluded_at: null,
    budget: { limits: null, pools: [] },
    reservations: [],
    jobs: [],
    runs: [],
    attention_items: [],
  });
  view.candidates = [
    {
      trial_slot: 'seed',
      kind: 'SEED',
      configuration_id: null,
      terminal_reason: null,
      strategy_hash: null,
      lifecycle: null,
      decision: null,
      eligibility: null,
    },
  ];
  return view as MissionView;
}

const everyView = (): string[][] => [
  missionLines(concluded),
  missionLines(freshMission()),
  budgetLines(concluded),
  budgetLines(freshMission()),
  lineageLines(fixture('lineage-view.three-versions.json') as never),
  trialsLines(fixture('trials-view.concluded.json') as never),
  findingsLines(fixture('findings-view.three-critiques.json') as never),
  gatesLines(fixture('gates-view.one-report.json') as never),
  decisionsLines(fixture('decisions-view.concluded.json') as never),
  decisionsLines({ schema_version: 'decisions-view/1', mission_id: 'msn-1', decisions: [] }),
];

describe('none recorded', () => {
  it('is shown for the EVALUATING -> PAPER Decision, and only there', () => {
    for (const view of [
      fixture('decisions-view.concluded.json'),
      { schema_version: 'decisions-view/1', mission_id: 'msn-1', decisions: [] },
    ]) {
      const lines = decisionsLines(view as never);
      const marked = lines.filter((line) => /none recorded/i.test(line));
      expect(marked).toEqual([NONE_RECORDED_LINE]);
      expect(NONE_RECORDED_LINE).toMatch(/^EVALUATING -> PAPER Decision: none recorded/);
    }
    for (const lines of everyView().slice(0, -2)) {
      expect(lines.filter((line) => /none recorded/i.test(line))).toEqual([]);
    }
  });

  it('is not shown when an EVALUATING -> PAPER Decision exists, and a missing DRAFT -> EVALUATING Decision is pending', () => {
    const view = fixture('decisions-view.concluded.json');
    view.decisions.push({ ...view.decisions[1], decision_id: 'dec-paper', kind: 'EVALUATING_TO_PAPER' });
    const lines = decisionsLines(view as never);
    expect(lines.join('\n')).not.toMatch(/none recorded/i);
    expect(lines.join('\n')).toContain('dec-paper EVALUATING -> PAPER slot seed: APPROVED');
    expect(missionLines(freshMission()).join('\n')).toContain('DRAFT -> EVALUATING Decision: pending');
  });
});

describe('the operating context', () => {
  it('labels the environment, the mode, the simulated money and account, and risk UNKNOWN with its reason', () => {
    const lines = headerLines(displayContext('DEVELOPMENT', '2026-11-15T10:00:00Z'));
    const text = lines.join('\n');
    expect(text).toContain('env DEV');
    expect(text).toContain('mode BACKTEST');
    expect(text).toContain('money SIMULATED');
    expect(text).toContain(`account: ${ACCOUNT}`);
    expect(ACCOUNT).toBe('simulated per-candidate ledger');
    expect(text).toContain(`risk: UNKNOWN - ${RISK_REASON}`);
    expect(text).not.toMatch(/risk: OK/);
    expect(text).toContain('read at: 2026-11-15T10:00:00Z');
    expect(headerLines(displayContext('PRODUCTION', null)).join('\n')).toContain('env PROD');
    expect(headerLines(displayContext('STAGING', null)).join('\n')).toContain('env STAGING');
    expect(headerLines(displayContext(null, null)).join('\n')).toContain('env UNKNOWN');
  });

  it('is printed with every result, in text and in --json', async () => {
    const cli = harness();
    try {
      await cli.login();
      cli.api.on('GET', '/v1/missions/msn-00000a', () => ({ status: 200, body: concluded }));
      const text = await cli.run(['mission', 'show', 'msn-00000a']);
      expect(text.stdout.text).toMatch(/^OpenQuant \| env DEV \| mode BACKTEST \| money SIMULATED \| tz UTC$/m);
      expect(text.stdout.text).toContain('risk: UNKNOWN - ');
      const json = JSON.parse((await cli.run(['mission', 'show', 'msn-00000a', '--json'])).stdout.text);
      expect(json.context).toEqual({
        environment: 'DEV',
        api_environment: 'DEVELOPMENT',
        mode: 'BACKTEST',
        money: 'SIMULATED',
        account: 'simulated per-candidate ledger',
        risk: { state: 'UNKNOWN', reason: RISK_REASON },
        observed_at: '2026-11-15T10:00:00Z',
        time_zone: 'UTC',
      });
    } finally {
      cli.cleanup();
    }
  });
});

describe('unknown values', () => {
  it('are shown as unknown or not yet recorded, never as zero', () => {
    const mission = missionLines(freshMission()).join('\n');
    expect(mission).toContain('evaluation plan: not recorded yet');
    expect(mission).toContain('started: not started');
    expect(mission).toContain('strategy: no registered version');
    expect(mission).toContain('eligibility: not assessed');
    const budget = budgetLines(freshMission());
    expect(budget).toContain('  limits: unknown (the mission records none)');
    // Nothing reported a budget amount, so no amount at all is printed, and no zero stands in for one.
    expect(budget.join('\n')).not.toMatch(/(^|[^\w.])0(\.0+)?([^\w.]|$)/m);
  });

  it('keep the reported values as the API states them, with their units', () => {
    const budget = budgetLines(concluded).join('\n');
    expect(budget).toContain('model spend: 105.00000000 USD; per attempt: 5.00000000 USD');
    expect(budget).toContain('MODEL_SPEND critic: 45.00000000 / 9.75000000 / 0.00000000');
    expect(budget).toContain('batch compute: 7200 s; agent compute: 18900 s');
  });
});

describe('untrusted text', () => {
  const hostile = 'AAPL \u001b[2J\u001b]0;owned\u0007 red\u001b[31m \u009b31m \u202eevil\u202c \u2028next\r over';

  it('reaches the terminal without a control sequence or a bidirectional override', () => {
    const view = structuredClone(concluded) as Doc;
    view.objective = hostile;
    view.attention_items = [
      { item_id: 'att-1', subject: hostile, reason: hostile, status: 'OPEN', opened_at: '2026-11-15T10:00:00Z' },
    ];
    const lines = wrapLines(missionLines(view as MissionView), MAX_WIDTH);
    for (const line of lines) {
      expect(line).not.toMatch(CONTROL);
      expect(line).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u2028\u2029]/);
    }
    expect(lines.join('\n')).toContain('AAPL ?[2J?]0;owned? red?[31m ?31m ?evil? ?next? over');
    expect(sanitize('a\tb\ud800c')).toBe('a b\ufffdc');
  });

  it('keeps its exact value in --json, escaped', () => {
    const text = safeJson({ objective: hostile });
    expect(text).not.toMatch(/[\u007f-\u009f\u202a-\u202e\u2028\u2029]/);
    expect(text.replace(/\n/g, '')).not.toMatch(CONTROL);
    expect(JSON.parse(text)).toEqual({ objective: hostile });
  });
});

describe('80 columns', () => {
  it('holds every line of every view, also with long tokens and wide characters', () => {
    const view = structuredClone(concluded) as Doc;
    view.objective = `${'x'.repeat(200)} ${'\u5e02\u5834'.repeat(60)} end`;
    const all = [...everyView(), missionLines(view as MissionView)];
    for (const lines of all) {
      for (const width of [80, 60, 40, 20]) {
        for (const line of wrapLines(lines, width)) expect(textWidth(line), line).toBeLessThanOrEqual(width);
      }
    }
    // Wrapping keeps every character: nothing is clipped.
    const wrapped = wrapLines([`  objective: ${view.objective}`], 80)
      .join('')
      .replace(/\s+/g, '');
    expect(wrapped).toBe(`objective:${view.objective}`.replace(/\s+/g, ''));
    // Every space between two words on one line is kept, also on the first line and after a hanging indent.
    const sentence = 'It cannot be undone; cancelling later stops further work but keeps what was spent.';
    for (const width of [20, 40, 80]) {
      expect(
        wrapLines([sentence], width)
          .map((line) => line.trim())
          .join(' '),
      ).toBe(sentence);
    }
  });

  it('holds the whole output of the CLI, header included', async () => {
    const cli = harness();
    try {
      await cli.login();
      cli.api.on('GET', '/v1/missions/msn-00000a/gates', () => ({
        status: 200,
        body: fixture('gates-view.one-report.json'),
      }));
      for (const tty of [false, true]) {
        const run = await cli.run(['mission', 'gates', 'msn-00000a'], { tty, columns: 200 });
        expect(run.exit).toBe(0);
        for (const line of run.stdout.text.split('\n')) expect(textWidth(line), line).toBeLessThanOrEqual(80);
      }
    } finally {
      cli.cleanup();
    }
  });
});
