// Timing helpers for the tests that check how the work of a parse grows with its input.
//
// A timing is noisy, so each one is the best of several trials, and a ratio is repeated: it passes
// when any of a few attempts stays under its limit. A real quadratic cost fails every attempt, and
// an attempt that sees it stops early so that a regression fails fast instead of hanging.

/** Eight times the input must cost less than this many times as much. Linear is 8, quadratic 64. */
export const MAX_RATIO = 20;
/** Input sizes of the scaling tests: n and 8n. */
export const SCALE = 8;

const now = () => performance.now();

/** The best time of one call in ms over `trials` runs of `reps` calls each. */
export function bestTime(run: () => void, reps: number, trials: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let trial = 0; trial < trials; trial += 1) {
    const started = now();
    for (let rep = 0; rep < reps; rep += 1) run();
    best = Math.min(best, (now() - started) / reps);
  }
  return best;
}

/** How many calls fill about a millisecond, at most 4,096: enough to time a call that is fast. */
function repsFor(run: () => void): number {
  run();
  let reps = 1;
  while (reps < 4_096 && bestTime(run, reps, 1) * reps < 1) reps *= 2;
  return reps;
}

/**
 * How much more one call on the large input costs than one on the small input, as the best of
 * `attempts` ratios. Each ratio compares best times. A large input that takes over `slowMs` for one
 * call ends the attempt at once with an infinite ratio.
 */
export function scalingRatio(small: () => void, large: () => void, attempts = 3, slowMs = 1_000): number {
  const smallReps = repsFor(small);
  const largeReps = Math.max(1, Math.floor(smallReps / SCALE));
  let best = Number.POSITIVE_INFINITY;
  for (let attempt = 0; attempt < attempts && best >= MAX_RATIO; attempt += 1) {
    const largeTime = bestTime(large, 1, 1);
    if (largeTime > slowMs) return Number.POSITIVE_INFINITY;
    const ratio = bestTime(large, largeReps, 5) / bestTime(small, smallReps, 5);
    best = Math.min(best, ratio);
  }
  return best;
}
