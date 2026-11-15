// Development script: run the offline agent suites (`pnpm --filter @openquant/agents run eval:fixture`).
//
// Fixture mode only. Every case uses a labelled synthetic response from fixtures/agent-results and no model call.
// A live run is not available here: it needs an explicit opt-in and the runner of apps/agent-runner, which no
// development script starts (OQ-03 sections 3 and 6).

import { runFixtures, SUITES } from './fixture-runner.ts';

const args = process.argv.slice(2);
const mode = args[args.indexOf('--mode') + 1] ?? 'fixture';
if (args.includes('--mode') && mode !== 'fixture') {
  console.error(
    `Mode ${mode} is not available: development scripts run in fixture mode only, and a real-model run needs an explicit opt-in through the agent runner.`,
  );
  process.exit(2);
}

const reports = await runFixtures();
let failed = 0;
for (const report of reports) {
  if (report.problems.length === 0) {
    console.log(`ok   ${report.suite}/${report.id}`);
  } else {
    failed += 1;
    console.log(`FAIL ${report.suite}/${report.id}`);
    for (const problem of report.problems) console.log(`       ${problem}`);
  }
}
const perSuite = SUITES.map((suite) => `${suite} ${reports.filter((report) => report.suite === suite).length}`).join(
  ', ',
);
console.log(`${reports.length} synthetic fixtures (${perSuite}), ${failed} failed. No model was called.`);
process.exit(failed === 0 && reports.length > 0 ? 0 : 1);
