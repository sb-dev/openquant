import test from 'node:test';
import assert from 'node:assert/strict';
import { root } from '../../repository.ts';
import { expectedTypescriptCommands, expectedWorkspacePackages, workspaceTasks } from '../../s0.ts';
import { dryRunArguments, turboDryRun, turboTaskErrors } from '../tasks.ts';

type Json = any;
const live: Json = turboDryRun(root);
const contracts = '@openquant/api-contracts';
const api = '@openquant/api';
const agents = '@openquant/agents';
const runner = '@openquant/agent-runner';
function withTask(id: string, change: (task: Json) => Json | undefined): Json {
  assert.ok(live.tasks.some((task: Json) => task.taskId === id), `the live dry run must list ${id}`);
  return { ...live, tasks: live.tasks.flatMap((task: Json) => (task.taskId === id ? [change(structuredClone(task))].filter(Boolean) : [task])) };
}
function rejects(dryRun: Json, expected: RegExp, label: string) {
  const errors = turboTaskErrors(dryRun);
  assert.ok(errors.some((error) => expected.test(error)), `${label}: ${errors.join(' | ') || 'no error'}`);
}

test('the dry run asks for the tasks that the Turborepo step runs', () => {
  assert.ok(expectedTypescriptCommands.includes(`pnpm exec turbo ${dryRunArguments.slice(0, -1).join(' ')} --force`));
  assert.equal(dryRunArguments.at(-1), '--dry=json');
});
test('the live Turborepo dry run lists exactly the expected package tasks', () => {
  assert.deepEqual(turboTaskErrors(live), []);
  assert.equal(live.tasks.length, expectedWorkspacePackages.length * workspaceTasks.length);
});

// C9: the reviewer replaced the only package in pnpm-workspace.yaml and reinstalled; Turborepo then ran no task
// and passed. Its dry run lists no package and no task.
test('C9: an empty workspace fails before Turborepo runs', () => {
  const empty = { ...live, packages: [], tasks: [] };
  rejects(empty, /must see exactly the workspace packages @openquant\/api-contracts, @openquant\/api, @openquant\/agents, @openquant\/agent-runner; it sees none/, 'no package');
  for (const name of [contracts, api, agents, runner]) {
    for (const task of workspaceTasks) rejects(empty, new RegExp(`must run ${name}#${task} once; turbo run typecheck lint test build --dry=json lists it 0 times`), `${name} ${task}`);
  }
});
test('a package without one of its tasks fails', () => {
  for (const name of [contracts, api, agents, runner]) {
    for (const task of workspaceTasks) rejects(withTask(`${name}#${task}`, () => undefined), new RegExp(`must run ${name}#${task} once`), `${name} ${task}`);
  }
});
test('a task whose script is missing or different fails', () => {
  // Turborepo lists a task for a package without the script, with this command, and runs nothing for it.
  rejects(withTask(`${contracts}#test`, (task) => ({ ...task, command: '<NONEXISTENT>' })), /would run @openquant\/api-contracts#test as "<NONEXISTENT>"/, 'missing script');
  rejects(withTask(`${contracts}#test`, (task) => ({ ...task, command: 'node tools/generate.ts' })), /would run @openquant\/api-contracts#test as "node tools\/generate\.ts"/, 'other script');
  rejects(withTask(`${api}#test`, (task) => ({ ...task, command: 'vitest run --passWithNoTests' })), /would run @openquant\/api#test as "vitest run --passWithNoTests"/, 'the API test script with another flag');
  rejects(withTask(`${api}#build`, (task) => ({ ...task, command: 'tsc -p tsconfig.json' })), /would run @openquant\/api#build as "tsc -p tsconfig\.json"/, 'the API build without the bundle check');
});
test('the agents package is pinned the same way', () => {
  rejects(withTask(`${agents}#test`, (task) => ({ ...task, command: '<NONEXISTENT>' })), /would run @openquant\/agents#test as "<NONEXISTENT>"/, 'missing script');
  rejects(withTask(`${agents}#lint`, (task) => ({ ...task, command: 'biome check .' })), /would run @openquant\/agents#lint as "biome check \."/, 'other script');
  rejects(withTask(`${agents}#build`, (task) => ({ ...task, cliArguments: ['--force'] })), /would pass extra arguments to @openquant\/agents#build/, 'arguments');
});
test('the agent runner package is pinned the same way', () => {
  rejects(withTask(`${runner}#test`, (task) => ({ ...task, command: '<NONEXISTENT>' })), /would run @openquant\/agent-runner#test as "<NONEXISTENT>"/, 'missing script');
  rejects(withTask(`${runner}#build`, (task) => ({ ...task, command: 'tsc -p tsconfig.json' })), /would run @openquant\/agent-runner#build as "tsc -p tsconfig\.json"/, 'other script');
  rejects(withTask(`${runner}#test`, (task) => ({ ...task, cliArguments: ['--testNamePattern', 'none'] })), /would pass extra arguments to @openquant\/agent-runner#test/, 'arguments');
  rejects(withTask(`${runner}#lint`, (task) => ({ ...task, directory: 'elsewhere' })), /would run @openquant\/agent-runner#lint in "elsewhere"/, 'directory');
});
test('extra arguments, another directory, an extra task or package fail', () => {
  rejects(withTask(`${contracts}#test`, (task) => ({ ...task, cliArguments: ['--testNamePattern', 'none'] })), /would pass extra arguments to @openquant\/api-contracts#test/, 'arguments');
  rejects(withTask(`${contracts}#lint`, (task) => ({ ...task, directory: 'elsewhere' })), /would run @openquant\/api-contracts#lint in "elsewhere"/, 'directory');
  const extra = { ...live, packages: [...live.packages, '@openquant/extra'], tasks: [...live.tasks, { ...live.tasks[0], taskId: '@openquant/extra#test' }] };
  rejects(extra, /a task that is not expected: @openquant\/extra#test/, 'extra task');
  rejects(extra, /it sees @openquant\/agent-runner, @openquant\/agents, @openquant\/api, @openquant\/api-contracts, @openquant\/extra/, 'extra package');
  rejects(withTask(`${api}#lint`, (task) => ({ ...task, cliArguments: ['--max-warnings=100'] })), /would pass extra arguments to @openquant\/api#lint/, 'arguments on the API');
  rejects({ ...live, tasks: [...live.tasks, live.tasks[0]] }, /lists it 2 times/, 'duplicate');
});
test('a dry run without a task list fails', () => assert.deepEqual(turboTaskErrors({}), ['turbo run typecheck lint test build --dry=json returned no task list']));
