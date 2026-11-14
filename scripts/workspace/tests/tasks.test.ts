import test from 'node:test';
import assert from 'node:assert/strict';
import { root } from '../../repository.ts';
import { expectedTypescriptCommands, expectedWorkspacePackages, workspaceTasks } from '../../s0.ts';
import { dryRunArguments, turboDryRun, turboTaskErrors } from '../tasks.ts';

type Json = any;
const live: Json = turboDryRun(root);
const contracts = '@openquant/api-contracts';
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
  rejects(empty, /must see exactly the workspace packages @openquant\/api-contracts; it sees none/, 'no package');
  for (const task of workspaceTasks) rejects(empty, new RegExp(`must run ${contracts}#${task} once; turbo run typecheck lint test build --dry=json lists it 0 times`), task);
});
test('a package without one of its tasks fails', () => {
  for (const task of workspaceTasks) rejects(withTask(`${contracts}#${task}`, () => undefined), new RegExp(`must run ${contracts}#${task} once`), task);
});
test('a task whose script is missing or different fails', () => {
  // Turborepo lists a task for a package without the script, with this command, and runs nothing for it.
  rejects(withTask(`${contracts}#test`, (task) => ({ ...task, command: '<NONEXISTENT>' })), /would run @openquant\/api-contracts#test as "<NONEXISTENT>"/, 'missing script');
  rejects(withTask(`${contracts}#test`, (task) => ({ ...task, command: 'node tools/generate.ts' })), /would run @openquant\/api-contracts#test as "node tools\/generate\.ts"/, 'other script');
});
test('extra arguments, another directory, an extra task or package fail', () => {
  rejects(withTask(`${contracts}#test`, (task) => ({ ...task, cliArguments: ['--testNamePattern', 'none'] })), /would pass extra arguments to @openquant\/api-contracts#test/, 'arguments');
  rejects(withTask(`${contracts}#lint`, (task) => ({ ...task, directory: 'elsewhere' })), /would run @openquant\/api-contracts#lint in "elsewhere"/, 'directory');
  const extra = { ...live, packages: [...live.packages, '@openquant/extra'], tasks: [...live.tasks, { ...live.tasks[0], taskId: '@openquant/extra#test' }] };
  rejects(extra, /a task that is not expected: @openquant\/extra#test/, 'extra task');
  rejects(extra, /it sees @openquant\/api-contracts, @openquant\/extra/, 'extra package');
  rejects({ ...live, tasks: [...live.tasks, live.tasks[0]] }, /lists it 2 times/, 'duplicate');
});
test('a dry run without a task list fails', () => assert.deepEqual(turboTaskErrors({}), ['turbo run typecheck lint test build --dry=json returned no task list']));
