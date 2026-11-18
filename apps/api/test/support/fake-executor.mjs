// A stand-in for the pinned Claude Code CLI in the connected test (apps/api/test/e2e.connected.test.ts). It is never the
// real binary and calls no model: it answers each role module and model with the text that a scenario file names, in
// the JSON shape that the agent runner reads. argv[2] is the scenario path; the rest is what the runner passed.
//
// The scenario maps "<skill>|<model>" (or "<skill>|*") to { "result": "<text>" } or { "refusal": true }.

import { readFileSync } from 'node:fs';

const [, , scenarioPath, ...args] = process.argv;
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

if (args[0] === '--version') {
  process.stdout.write(`${scenario.version} (Claude Code)\n`);
  process.exit(0);
}

const prompt = args.find((argument) => argument.startsWith('--system-prompt=')) ?? '';
const skill = ['strategy-formulation', 'strategy-critique'].find((name) => prompt.includes(`skill: ${name}`));
const model = option('--model') ?? 'unknown';
const answer = scenario.answers[`${skill}|${model}`] ?? scenario.answers[`${skill}|*`];

process.stdin.resume();
process.stdin.on('data', () => undefined);
process.stdin.on('end', () => {
  const report = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    stop_reason: answer?.refusal === true ? 'refusal' : 'end_turn',
    session_id: option('--session-id'),
    total_cost_usd: 0.01,
    usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 20 },
    modelUsage: { [model]: { outputTokens: 20, provider: 'firstParty' } },
    result: answer?.refusal === true ? 'No.' : (answer?.result ?? ''),
  };
  process.stdout.write(JSON.stringify(report), () => process.exit(answer === undefined ? 3 : 0));
});
