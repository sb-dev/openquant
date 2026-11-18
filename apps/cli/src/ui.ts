// Ink components (OQ-04 sections 10 to 13). Ink renders only in a terminal and never in --json mode (OQ-05 section 8).
// Every line is sanitised and wrapped to the output width (at most 80 columns), so a resize re-wraps and never clips.
// Focus is shown with text markers, never with colour alone. A confirmation dialog owns focus, starts on the safe
// choice, needs Enter on a focused button, and refuses to proceed in a terminal too narrow to show it whole.

import type { MissionView } from '@openquant/api-contracts';
import { Box, Text, useApp, useFocus, useFocusManager, useInput, useWindowSize } from 'ink';
import { createElement as h, type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { budgetLines, missionLines } from './format.ts';
import { outputWidth, sanitizeLine, wrapLines } from './text.ts';

/** The narrowest terminal in which a confirmation is shown: below it the operator must widen the terminal first. */
export const MIN_CONFIRM_WIDTH = 40;

/** Pre-wrapped lines as Ink text. */
export function Lines({ lines }: { readonly lines: readonly string[] }): ReactElement {
  return h(
    Box,
    { flexDirection: 'column' },
    lines.map((line, index) => h(Text, { key: index }, line === '' ? ' ' : line)),
  );
}

/** A static report: the same lines as the plain output, rendered once. */
export function Report({ lines, width }: { readonly lines: readonly string[]; readonly width: number }): ReactElement {
  return h(Lines, { lines: wrapLines(lines, width) });
}

function Button({
  id,
  label,
  autoFocus,
  onPress,
}: {
  readonly id: string;
  readonly label: string;
  readonly autoFocus: boolean;
  readonly onPress: () => void;
}): ReactElement {
  const { isFocused } = useFocus({ id, autoFocus });
  // Enter acts only on the focused button; a pasted text is never a key press.
  useInput(
    (input, key) => {
      if (key.return && input.length <= 1) onPress();
    },
    { isActive: isFocused },
  );
  return h(Text, null, isFocused ? `>[ ${label} ]<` : ` [ ${label} ] `);
}

export interface ConfirmProps {
  /** The exact action, such as RUN NOW. */
  readonly action: string;
  /** Object, consequence, reversibility and the state that was read for it. */
  readonly details: readonly string[];
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly onDecision: (confirmed: boolean) => void;
}

/** An explicit confirmation (OQ-04 section 13): the safe choice has focus; Esc or Ctrl+C declines. */
export function Confirm({ action, details, confirmLabel, cancelLabel, onDecision }: ConfirmProps): ReactElement {
  const { columns } = useWindowSize();
  const { focusNext, focusPrevious } = useFocusManager();
  const decided = useRef(false);
  const decide = useCallback(
    (confirmed: boolean) => {
      if (decided.current) return;
      decided.current = true;
      onDecision(confirmed);
    },
    [onDecision],
  );
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) decide(false);
    else if (key.leftArrow) focusPrevious();
    else if (key.rightArrow) focusNext();
  });
  const width = outputWidth(columns);
  if (columns < MIN_CONFIRM_WIDTH) {
    return h(Lines, {
      lines: wrapLines(
        [
          `${action}: the terminal is ${columns} columns wide.`,
          `Widen it to at least ${MIN_CONFIRM_WIDTH} columns to review this action. Esc cancels.`,
        ],
        width,
      ),
    });
  }
  return h(
    Box,
    { flexDirection: 'column' },
    h(Lines, { lines: wrapLines([`Confirm ${action}`, ...details, ''], width) }),
    h(
      Box,
      { flexDirection: 'row', gap: 1 },
      h(Button, { id: 'cancel', label: cancelLabel, autoFocus: true, onPress: () => decide(false) }),
      h(Button, { id: 'confirm', label: confirmLabel, autoFocus: false, onPress: () => decide(true) }),
    ),
    h(Lines, { lines: wrapLines(['Tab or Left/Right moves focus; Enter chooses; Esc cancels.'], width) }),
  );
}

const TABS = ['Summary', 'Budget'] as const;

export interface WatchProps {
  readonly missionId: string;
  readonly load: () => Promise<MissionView>;
  readonly intervalMs: number;
  /** The longest wait between reads after failures (bounded exponential backoff). */
  readonly maxBackoffMs: number;
  readonly now: () => Date;
  /** The context header for a state read at the given time, or null before the first read. */
  readonly header: (observedAt: string | null) => readonly string[];
}

interface WatchState {
  readonly view: MissionView | undefined;
  readonly observedAt: string | null;
  readonly failure: { readonly at: string; readonly message: string } | undefined;
  readonly loading: boolean;
}

const stamp = (date: Date) => `${date.toISOString().slice(0, 19)}Z`;

function TabBar({ tab, onTab }: { readonly tab: number; readonly onTab: (next: number) => void }): ReactElement {
  const { isFocused } = useFocus({ id: 'tabs', autoFocus: true });
  useInput(
    (input, key) => {
      if (key.leftArrow || input === 'h') onTab((tab + TABS.length - 1) % TABS.length);
      if (key.rightArrow || input === 'l') onTab((tab + 1) % TABS.length);
    },
    { isActive: isFocused },
  );
  const labels = TABS.map((name, index) => (index === tab ? `[${name}]` : ` ${name} `)).join(' ');
  return h(Text, null, `${isFocused ? '> ' : '  '}${labels}`);
}

/**
 * A mission, read again every interval (OQ-05 section 8: S1 polls with bounds). A failed read keeps the last state on
 * screen marked STALE with its read time and the failure, until a read succeeds. Leaving detaches: the mission keeps
 * running, and only `openquant mission cancel` cancels it (OQ-04 section 10).
 */
export function MissionWatch(props: WatchProps): ReactElement {
  const { exit } = useApp();
  const { columns } = useWindowSize();
  const [tab, setTab] = useState(0);
  const [state, setState] = useState<WatchState>({
    view: undefined,
    observedAt: null,
    failure: undefined,
    loading: true,
  });
  const failures = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const { load, intervalMs, maxBackoffMs, now } = props;

  const refresh = useCallback(async () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    setState((previous) => ({ ...previous, loading: true }));
    try {
      const view = await load();
      if (!alive.current) return;
      failures.current = 0;
      setState({ view, observedAt: stamp(now()), failure: undefined, loading: false });
    } catch (error) {
      if (!alive.current) return;
      failures.current += 1;
      const message = error instanceof Error ? error.message : 'the read failed';
      setState((previous) => ({ ...previous, failure: { at: stamp(now()), message }, loading: false }));
    }
    if (!alive.current) return;
    const delay = Math.min(maxBackoffMs, intervalMs * 2 ** Math.min(failures.current, 16));
    timer.current = setTimeout(() => void refresh(), delay);
  }, [load, intervalMs, maxBackoffMs, now]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
      if (timer.current !== undefined) clearTimeout(timer.current);
    };
  }, [refresh]);

  useInput((input, key) => {
    if (input === 'q' || key.escape || (key.ctrl && input === 'c')) exit();
    else if (input === 'r') void refresh();
  });

  const width = outputWidth(columns);
  const lines: string[] = [...props.header(state.observedAt)];
  if (state.failure !== undefined) {
    lines.push(
      `STALE: the read at ${state.failure.at} failed (${sanitizeLine(state.failure.message)}).`,
      state.observedAt === null
        ? 'Nothing has been read yet.'
        : `Shown: the state read at ${state.observedAt}. It may have changed since.`,
    );
  } else if (state.view === undefined) {
    lines.push(`Reading mission ${props.missionId} ...`);
  }
  const body =
    state.view === undefined ? [] : TABS[tab] === 'Budget' ? budgetLines(state.view) : missionLines(state.view);
  return h(
    Box,
    { flexDirection: 'column' },
    h(Lines, { lines: wrapLines(lines, width) }),
    h(TabBar, { tab, onTab: setTab }),
    h(Lines, { lines: wrapLines(body, width) }),
    h(Lines, {
      lines: wrapLines(
        [
          `NAVIGATION | Tab focus | Left/Right tab | r refresh | q quit (detaches; the mission keeps running)${state.loading ? ' | reading' : ''}`,
        ],
        width,
      ),
    }),
  );
}
