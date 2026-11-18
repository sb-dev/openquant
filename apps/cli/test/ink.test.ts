// Ink behaviour (OQ-04 sections 10 to 13; OQ-06 section 2.2: Ink state, focus, resize, stale state, non-TTY): a
// confirmation starts on the safe choice and moves focus with Tab; a pasted text is not a key press; a resize re-wraps
// within the new width and a too-narrow terminal blocks a confirmation; a failed refresh marks the state STALE and
// keeps it; a non-terminal gets plain text; --json prints one JSON document and never renders Ink.

import type { MissionView } from '@openquant/api-contracts';
import { render } from 'ink';
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { displayContext, headerLines } from '../src/context.ts';
import { textWidth } from '../src/text.ts';
import { Confirm, MissionWatch } from '../src/ui.ts';
import { CONTROL, type Doc, fixture, harness, settle, TestInput, TestOutput, until } from './support.ts';

const mission = fixture('mission-view.concluded.json') as MissionView;
const unmounts: (() => void)[] = [];

afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
});

function mount(element: Parameters<typeof render>[0], columns = 100) {
  const stdout = new TestOutput(true, columns);
  const stdin = new TestInput();
  const instance = render(element, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: new TestOutput(true, columns) as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  unmounts.push(() => instance.unmount());
  return { stdout, stdin, instance };
}

const visibleLines = (frame: string) => frame.split('\n').filter((line) => line.trim() !== '');

function confirmFor(decisions: boolean[], columns = 100) {
  return mount(
    h(Confirm, {
      action: 'RUN NOW msn-1',
      details: ['Mission msn-1: CREATED, revision 1', 'Safe default: keep the mission as it is.'],
      confirmLabel: 'Run now',
      cancelLabel: 'Keep as is',
      onDecision: (confirmed: boolean) => decisions.push(confirmed),
    }),
    columns,
  );
}

describe('focus', () => {
  it('starts on the safe choice, which Enter chooses', async () => {
    const decisions: boolean[] = [];
    const { stdout, stdin } = confirmFor(decisions);
    await until(() => stdout.lastFrame().includes('>[ Keep as is ]<'), 'the focused safe choice');
    expect(stdout.lastFrame()).toContain(' [ Run now ]');
    stdin.type('\r');
    await until(() => decisions.length === 1, 'a decision');
    expect(decisions).toEqual([false]);
  });

  it('moves with Tab and Shift+Tab, shows the focus with text, and confirms only on Enter', async () => {
    const decisions: boolean[] = [];
    const { stdout, stdin } = confirmFor(decisions);
    await until(() => stdout.lastFrame().includes('>[ Keep as is ]<'), 'the first frame');
    stdin.type('\t');
    await until(() => stdout.lastFrame().includes('>[ Run now ]<'), 'focus on the action');
    expect(stdout.lastFrame()).toContain(' [ Keep as is ]');
    stdin.type('\u001b[Z');
    await until(() => stdout.lastFrame().includes('>[ Keep as is ]<'), 'focus back on the safe choice');
    stdin.type('\u001b[C');
    await until(() => stdout.lastFrame().includes('>[ Run now ]<'), 'focus moved with Right');
    // A paste is text, not a key press: it carries a return but confirms nothing.
    stdin.type('yes\r');
    await settle();
    expect(decisions).toEqual([]);
    stdin.type('\r');
    await until(() => decisions.length === 1, 'a decision');
    expect(decisions).toEqual([true]);
  });

  it('declines on Esc and on Ctrl+C', async () => {
    for (const key of ['\u001b', '\u0003']) {
      const decisions: boolean[] = [];
      const { stdout, stdin } = confirmFor(decisions);
      await until(() => stdout.lastFrame().includes('>[ Keep as is ]<'), 'the first frame');
      stdin.type('\t');
      await until(() => stdout.lastFrame().includes('>[ Run now ]<'), 'focus on the action');
      stdin.type(key);
      await until(() => decisions.length === 1, `a decision after ${JSON.stringify(key)}`);
      expect(decisions).toEqual([false]);
    }
  });
});

function watch(load: () => Promise<MissionView>, columns = 100) {
  let clock = Date.parse('2026-11-15T10:00:00Z');
  return mount(
    h(MissionWatch, {
      missionId: 'msn-00000a',
      load,
      intervalMs: 200,
      maxBackoffMs: 400,
      now: () => {
        clock += 1000;
        return new Date(clock);
      },
      header: (observedAt: string | null) => headerLines(displayContext('DEVELOPMENT', observedAt)),
    }),
    columns,
  );
}

describe('resize', () => {
  it('re-wraps the view within the new width, never wider than 80 columns', async () => {
    const view = structuredClone(mission) as Doc;
    view.objective = `${'word '.repeat(40)}end`;
    const { stdout } = watch(async () => view as MissionView, 120);
    await until(() => stdout.lastFrame().includes('status: CONCLUDED'), 'the mission');
    const widest = (frame: string) => Math.max(...visibleLines(frame).map(textWidth));
    expect(widest(stdout.lastFrame())).toBeLessThanOrEqual(80);
    expect(widest(stdout.lastFrame())).toBeGreaterThan(60);
    stdout.resize(50);
    await until(() => widest(stdout.lastFrame()) <= 50, 'a frame within 50 columns');
    expect(stdout.lastFrame()).toContain('status: CONCLUDED');
    expect(stdout.lastFrame().replace(/\s+/g, '')).toContain(view.objective.replace(/\s+/g, ''));
    stdout.resize(200);
    await until(() => widest(stdout.lastFrame()) > 50, 'a wider frame');
    expect(widest(stdout.lastFrame())).toBeLessThanOrEqual(80);
  });

  it('blocks a confirmation in a terminal too narrow to show it, until it is widened', async () => {
    const decisions: boolean[] = [];
    const { stdout, stdin } = confirmFor(decisions, 30);
    await until(() => /Widen it to at least 40\s+columns/.test(stdout.lastFrame()), 'the resize request');
    expect(stdout.lastFrame()).not.toContain('Run now');
    stdin.type('\r');
    await settle();
    expect(decisions).toEqual([]);
    stdout.resize(60);
    await until(() => stdout.lastFrame().includes('>[ Keep as is ]<'), 'the dialog after widening');
  });
});

describe('stale state', () => {
  it('keeps the last state after a failed read, marked STALE with its read time, until a read succeeds', async () => {
    let calls = 0;
    const { stdout } = watch(async () => {
      calls += 1;
      if (calls === 2 || calls === 3) throw new Error('UNAVAILABLE: the API is down');
      return { ...mission, status: calls === 1 ? 'IN_PROGRESS' : 'CONCLUDED' } as MissionView;
    });
    await until(() => stdout.lastFrame().includes('status: IN_PROGRESS'), 'the first read');
    expect(stdout.lastFrame()).not.toContain('STALE');
    await until(() => stdout.lastFrame().includes('STALE'), 'the stale mark');
    const stale = stdout.lastFrame();
    expect(stale).toMatch(/STALE: the read at \S+ failed \(UNAVAILABLE: the API is down\)/);
    expect(stale).toMatch(/Shown: the state read at 2026-11-15T10:00:01Z/);
    expect(stale).toContain('status: IN_PROGRESS');
    await until(() => stdout.lastFrame().includes('status: CONCLUDED'), 'a successful read');
    expect(stdout.lastFrame()).not.toContain('STALE');
  });

  it('says that nothing has been read when the first read fails', async () => {
    const { stdout } = watch(async () => {
      throw new Error('no answer');
    });
    await until(() => stdout.lastFrame().includes('STALE'), 'the stale mark');
    expect(stdout.lastFrame()).toContain('Nothing has been read yet.');
    expect(stdout.lastFrame()).toContain('read at: nothing read from the API');
  });

  it('changes tab with Right while the tab bar has focus, and quits on q without cancelling anything', async () => {
    const { stdout, stdin, instance } = watch(async () => mission);
    await until(() => stdout.lastFrame().includes('> [Summary]'), 'the tab bar');
    stdin.type('\u001b[C');
    await until(() => stdout.lastFrame().includes('[Budget]'), 'the budget tab');
    expect(stdout.lastFrame()).toContain('Pools (limit / committed / overrun');
    stdin.type('q');
    await instance.waitUntilExit();
  });
});

describe('non-terminal and --json output', () => {
  it('prints plain text without escape sequences to a pipe', async () => {
    const cli = harness();
    try {
      await cli.login();
      cli.api.on('GET', '/v1/missions/msn-00000a/decisions', () => ({
        status: 200,
        body: fixture('decisions-view.concluded.json'),
      }));
      const run = await cli.run(['mission', 'decisions', 'msn-00000a']);
      expect(run.exit).toBe(0);
      expect(run.stdout.text.replace(/\n/g, '')).not.toMatch(CONTROL);
      expect(run.stdout.text).toContain('EVALUATING -> PAPER Decision: none recorded');
      // The terminal gets the same lines through Ink.
      const tty = await cli.run(['mission', 'decisions', 'msn-00000a'], { tty: true, columns: 80 });
      expect(tty.stdout.text.replace(/\n/g, '')).not.toMatch(CONTROL);
      expect(tty.stdout.text.trim()).toBe(run.stdout.text.trim());
    } finally {
      cli.cleanup();
    }
  });

  it('refuses an interactive command on a pipe and sends nothing', async () => {
    const cli = harness();
    try {
      await cli.login();
      cli.api.on('GET', '/v1/missions/msn-00000a', () => ({ status: 200, body: mission }));
      const watching = await cli.run(['mission', 'watch', 'msn-00000a']);
      expect(watching.exit).toBe(2);
      expect(watching.stderr.text).toContain('mission watch needs an interactive terminal.');
      const running = await cli.run(['mission', 'run-now', 'msn-00000a']);
      expect(running.exit).toBe(2);
      expect(running.stderr.text).toContain('needs a confirmation');
      expect(running.stderr.text).toContain('Nothing was sent.');
      expect(cli.api.sent.filter((sent) => sent.method === 'POST' && sent.path !== '/v1/auth/token')).toEqual([]);
    } finally {
      cli.cleanup();
    }
  });

  it('prints one JSON document with --json, even in a terminal, and never renders Ink', async () => {
    const cli = harness();
    try {
      await cli.login();
      cli.api.on('GET', '/v1/missions/msn-00000a', () => ({ status: 200, body: mission }));
      for (const tty of [false, true]) {
        const run = await cli.run(['mission', 'show', 'msn-00000a', '--json'], { tty });
        expect(run.exit).toBe(0);
        expect(run.stdout.writes).toHaveLength(1);
        const document = JSON.parse(run.stdout.text);
        expect(document).toMatchObject({ openquant_cli: 1, command: 'mission show', outcome: 'OK', exit_code: 0 });
        expect(document.data).toEqual(mission);
        expect(run.stderr.text).toBe('');
      }
      const watching = await cli.run(['mission', 'watch', 'msn-00000a', '--json'], { tty: true });
      expect(watching.exit).toBe(2);
      expect(JSON.parse(watching.stdout.text).error.code).toBe('CLI_USAGE');
      const confirming = await cli.run(['mission', 'run-now', 'msn-00000a', '--json'], { tty: true });
      expect(confirming.exit).toBe(2);
      expect(JSON.parse(confirming.stdout.text).outcome).toBe('USAGE');
    } finally {
      cli.cleanup();
    }
  });
});
