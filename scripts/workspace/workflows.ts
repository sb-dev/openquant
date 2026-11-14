import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

// Parsed-YAML checks of the GitHub workflows and Dependabot (OQ-06 sections 2.1 to 2.3). They read the YAML
// as GitHub does, so a comment, an `echo`, `|| true` or a constant `if` cannot satisfy them. They are static:
// they do not emulate Actions. The text checks in scripts/repository.ts and scripts/s0.ts stay as the
// dependency-free first line; these run after the dependency install, in the TypeScript steps of verify.

type Json = any;

const sha = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/;
const isMap = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);

// The steps of the `checks` job, exactly as written and in this order: names, pinned action commits, `with`
// inputs and commands, and no other key (no env, if, shell, working-directory, id or continue-on-error). The pnpm
// version comes from the packageManager field of package.json, so a different pnpm cannot install the lockfile in
// CI. The checkout keeps only persist-credentials: false, so CI checks out the revision under test and no other.
// A Dependabot update of either action changes this list in the same reviewed change.
export function expectedChecksSteps(pnpm: string): ReadonlyArray<Record<string, Json>> {
  return [
    { name: 'Check out source', uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', with: { 'persist-credentials': false } },
    { name: 'Set up Node', uses: 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1', with: { 'node-version-file': '.node-version', 'package-manager-cache': false } },
    { name: 'Install pinned pnpm', run: `npm install --global --ignore-scripts pnpm@${pnpm}` },
    { name: 'Install locked dependencies', run: 'pnpm install --frozen-lockfile' },
    { name: 'Install pinned Rust toolchain', run: 'rustup toolchain install --profile minimal' },
    { name: 'Verify repository', run: 'node scripts/verify.ts' },
  ];
}

// The only environment variables ci.yml may set at workflow or job level, with their only values.
export const allowedCiEnvironment: Readonly<Record<string, string>> = { CARGO_INCREMENTAL: '0', CARGO_TERM_COLOR: 'always' };

// Variables that change which shell file runs first, which Node, Rust, Cargo, Turborepo, Biome, npm or pnpm
// options apply, or which tests run. ci.yml may not set them anywhere, except the allowed values above.
export function bannedCiVariable(name: string): boolean {
  const key = name.toUpperCase();
  return ['BASH_ENV', 'ENV', 'NODE_OPTIONS', 'RUSTFLAGS', 'RUSTDOCFLAGS', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'BIOME_CONFIG_PATH'].includes(key)
    || /^(?:NODE_TEST_|CARGO_|TURBO_|NPM_CONFIG_|PNPM_CONFIG_)/.test(key);
}

function sameValue(left: Json, right: Json): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }
  if (isMap(left) || isMap(right)) {
    if (!isMap(left) || !isMap(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => key in right && sameValue(left[key], right[key]));
  }
  return left === right;
}

// An `if` whose value is constant false disables its job or step.
export function constantFalse(condition: unknown): boolean {
  if (condition === false || condition === 0 || condition === null) return true;
  if (typeof condition !== 'string') return false;
  const expression = condition.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1').trim().toLowerCase();
  return ['false', '0', 'null', "''", '""', '-0', '!true', '!1'].includes(expression);
}

function readOnly(permissions: unknown): boolean {
  if (permissions === 'read-all' || permissions === 'none') return true;
  return isMap(permissions) && Object.values(permissions).every((value) => value === 'read' || value === 'none');
}

function stepsOf(job: Json): Json[] {
  return Array.isArray(job?.steps) ? job.steps.filter(isMap) : [];
}

// Rules for every workflow file.
export function workflowErrors(file: string, text: string): string[] {
  const errors: string[] = [];
  let workflow: Json;
  try {
    workflow = parse(text, { uniqueKeys: true, prettyErrors: false });
  } catch (error) {
    return [`${file}: invalid YAML: ${error instanceof Error ? error.message : error}`];
  }
  if (!isMap(workflow) || !isMap(workflow.jobs) || workflow.on === undefined) return [`${file}: a workflow needs on and jobs`];
  if (!readOnly(workflow.permissions)) errors.push(`${file}: top-level permissions must be read-only`);
  const triggers = typeof workflow.on === 'string' ? [workflow.on] : Array.isArray(workflow.on) ? workflow.on : Object.keys(workflow.on ?? {});
  if (triggers.includes('pull_request_target') || triggers.includes('workflow_run')) errors.push(`${file}: privileged triggers are prohibited`);
  for (const [id, job] of Object.entries(workflow.jobs as Record<string, Json>)) {
    const where = `${file}: job ${id}`;
    if (!isMap(job)) { errors.push(`${where} is not a mapping`); continue; }
    if ('continue-on-error' in job && job['continue-on-error'] !== false) errors.push(`${where} must not set continue-on-error`);
    if ('if' in job && constantFalse(job.if)) errors.push(`${where} is disabled by a constant false if`);
    if (typeof job.uses === 'string' && !job.uses.startsWith('./') && !sha.test(job.uses)) errors.push(`${where} must use a full commit SHA: ${job.uses}`);
    stepsOf(job).forEach((step, index) => {
      const at = `${where} step ${index + 1}${typeof step.name === 'string' ? ` (${step.name})` : ''}`;
      if ('continue-on-error' in step && step['continue-on-error'] !== false) errors.push(`${at} must not set continue-on-error`);
      if ('if' in step && constantFalse(step.if)) errors.push(`${at} is disabled by a constant false if`);
      if (typeof step.uses === 'string' && !step.uses.startsWith('./') && !sha.test(step.uses)) errors.push(`${at} must use a full commit SHA: ${step.uses}`);
    });
  }
  return errors;
}

// ci.yml sets environment variables only at workflow and job level, and only the allowed ones with their values;
// required steps set none (their keys are fixed above). No env anywhere may set a banned variable, so neither
// another job nor the aggregate can carry one.
function environmentErrors(file: string, workflow: Json): string[] {
  const errors: string[] = [];
  const scopes: Array<[string, Json, boolean]> = [['the workflow', workflow.env, true]];
  for (const [id, job] of Object.entries(workflow.jobs as Record<string, Json>)) {
    if (!isMap(job)) continue;
    scopes.push([`job ${id}`, job.env, id !== 'ci']);
    stepsOf(job).forEach((step, index) => scopes.push([`job ${id} step ${index + 1}`, step.env, false]));
  }
  for (const [where, env, allowListed] of scopes) {
    if (env === undefined) continue;
    if (!isMap(env)) { errors.push(`${file}: ${where} env must be a mapping`); continue; }
    for (const [name, value] of Object.entries(env)) {
      const allowed = allowListed && name in allowedCiEnvironment;
      if (allowed && value !== allowedCiEnvironment[name]) errors.push(`${file}: ${where} must set ${name} to ${JSON.stringify(allowedCiEnvironment[name])}, found ${JSON.stringify(value)}`);
      else if (!allowed && bannedCiVariable(name)) errors.push(`${file}: ${where} must not set ${name}`);
      else if (!allowed && allowListed) errors.push(`${file}: ${where} may set only ${Object.keys(allowedCiEnvironment).join(' and ')}, found ${name}`);
    }
  }
  return errors;
}

// The aggregate job `ci` must run after every other job whatever their result, and fail unless each succeeded.
// Its shape is fixed: these keys only, on ubuntu-latest, and steps that only test needs.<job>.result values.
function aggregateErrors(file: string, jobs: Record<string, Json>): string[] {
  const errors: string[] = [];
  const ci = jobs.ci;
  if (!isMap(ci)) return [`${file}: the aggregate job ci is missing`];
  for (const key of Object.keys(ci)) {
    if (!['name', 'if', 'needs', 'runs-on', 'timeout-minutes', 'steps'].includes(key)) errors.push(`${file}: the aggregate job ci must not set ${key}`);
  }
  if (ci.name !== 'ci') errors.push(`${file}: the aggregate job ci must be named ci`);
  if (ci['runs-on'] !== 'ubuntu-latest') errors.push(`${file}: the aggregate job ci must run on ubuntu-latest, found ${JSON.stringify(ci['runs-on'])}`);
  if (!Number.isInteger(ci['timeout-minutes']) || ci['timeout-minutes'] < 1) errors.push(`${file}: the aggregate job ci needs a timeout-minutes`);
  if (!Array.isArray(ci.steps) || ci.steps.length === 0) errors.push(`${file}: the aggregate job ci needs steps`);
  for (const step of Array.isArray(ci.steps) ? ci.steps : []) {
    const keys = isMap(step) ? Object.keys(step) : [];
    if (!isMap(step) || keys.some((key) => !['name', 'env', 'run'].includes(key)) || !('run' in step) || !isMap(step.env)) {
      errors.push(`${file}: an aggregate step may set only name, env and run: ${JSON.stringify(step)}`);
    }
  }
  const others = Object.keys(jobs).filter((id) => id !== 'ci');
  const needs: string[] = typeof ci.needs === 'string' ? [ci.needs] : Array.isArray(ci.needs) ? ci.needs : [];
  for (const id of others) if (!needs.includes(id)) errors.push(`${file}: the aggregate job ci must need ${id}`);
  for (const id of needs) if (!others.includes(id)) errors.push(`${file}: the aggregate job ci needs an unknown job ${id}`);
  if (typeof ci.if !== 'string' || !['${{ always() }}', 'always()'].includes(ci.if.trim())) errors.push(`${file}: the aggregate job ci must run with if: \${{ always() }} and nothing else`);
  const checked = new Set<string>();
  for (const step of stepsOf(ci)) {
    if ('if' in step || 'continue-on-error' in step || 'shell' in step) errors.push(`${file}: an aggregate step must not set if, continue-on-error or shell`);
    if (typeof step.run !== 'string') continue;
    for (const line of step.run.split('\n').map((item: string) => item.trim()).filter(Boolean)) {
      const variable = /^test "\$([A-Z_][A-Z0-9_]*)" = success$/.exec(line)?.[1];
      const source = variable ? /^\$\{\{\s*needs\.([\w-]+)\.result\s*\}\}$/.exec(String(step.env?.[variable] ?? ''))?.[1] : undefined;
      if (!source) errors.push(`${file}: an aggregate step may only run test "$RESULT" = success for an env value of needs.<job>.result: ${line}`);
      else checked.add(source);
    }
  }
  for (const id of needs) if (!checked.has(id)) errors.push(`${file}: the aggregate job ci must check that ${id} succeeded`);
  return errors;
}

// Rules for ci.yml: triggers, the checks job and its required steps, and the aggregate.
export function ciWorkflowErrors(text: string, pnpm: string): string[] {
  const file = '.github/workflows/ci.yml';
  const errors = workflowErrors(file, text);
  let workflow: Json;
  try { workflow = parse(text, { uniqueKeys: true, prettyErrors: false }); } catch { return errors; }
  if (!isMap(workflow) || !isMap(workflow.jobs)) return errors;
  const on = isMap(workflow.on) ? workflow.on : {};
  if (!('pull_request' in on)) errors.push(`${file}: the pull_request trigger is required`);
  else if (on.pull_request !== null && !(isMap(on.pull_request) && Object.keys(on.pull_request).length === 0)) errors.push(`${file}: the pull_request trigger must not be filtered`);
  if (!('push' in on)) errors.push(`${file}: the push trigger is required`);
  else if (on.push !== null) {
    const keys = isMap(on.push) ? Object.keys(on.push) : ['?'];
    const branches = on.push?.branches;
    if (keys.some((key) => key !== 'branches') || !Array.isArray(branches) || !branches.includes('main')) errors.push(`${file}: the push trigger may only filter branches, and must include main`);
  }
  if (isMap(workflow.defaults)) errors.push(`${file}: workflow defaults must not change how steps run`);
  for (const key of Object.keys(workflow)) {
    if (!['name', 'on', 'permissions', 'concurrency', 'env', 'jobs', 'defaults'].includes(key)) errors.push(`${file}: the workflow must not set ${key}`);
  }
  for (const [id, job] of Object.entries(workflow.jobs as Record<string, Json>)) {
    if (isMap(job) && 'permissions' in job && !readOnly(job.permissions)) errors.push(`${file}: job ${id} must not grant write permissions`);
    if (isMap(job) && isMap(job.defaults)) errors.push(`${file}: job ${id} defaults must not change how steps run`);
  }
  const checks = workflow.jobs.checks;
  if (!isMap(checks)) return [...errors, `${file}: the checks job is missing`];
  for (const key of Object.keys(checks)) {
    if (!['name', 'runs-on', 'timeout-minutes', 'env', 'steps'].includes(key)) errors.push(`${file}: the checks job must not set ${key}`);
  }
  if (checks.name !== 'Repository checks') errors.push(`${file}: the checks job must be named Repository checks`);
  if (checks['runs-on'] !== 'ubuntu-latest') errors.push(`${file}: the checks job must run on ubuntu-latest, found ${JSON.stringify(checks['runs-on'])}`);
  const timeout = checks['timeout-minutes'];
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 20) errors.push(`${file}: the checks job needs timeout-minutes of at least 20, found ${JSON.stringify(timeout)}`);
  const steps: Json[] = Array.isArray(checks.steps) ? checks.steps : [];
  const expected = expectedChecksSteps(pnpm);
  if (steps.length !== expected.length) errors.push(`${file}: the checks job must have exactly ${expected.length} steps, found ${steps.length}`);
  for (let index = 0; index < Math.max(steps.length, expected.length); index += 1) {
    const [want, step] = [expected[index], steps[index]];
    if (want === undefined) { errors.push(`${file}: the checks job has an unexpected step ${index + 1}: ${JSON.stringify(step)}`); continue; }
    const at = `${file}: checks step ${index + 1} (${want.name})`;
    if (!isMap(step)) { errors.push(`${at} is missing`); continue; }
    for (const key of Object.keys(step)) if (!(key in want)) errors.push(`${at} must not set ${key}`);
    for (const [key, value] of Object.entries(want)) {
      if (!(key in step)) errors.push(`${at} must set ${key}: ${JSON.stringify(value)}`);
      else if (!sameValue(step[key], value)) errors.push(`${at} must have ${key}: ${JSON.stringify(value)}, found ${JSON.stringify(step[key])}`);
    }
  }
  errors.push(...environmentErrors(file, workflow));
  const verifySteps = Object.values(workflow.jobs as Record<string, Json>).flatMap((job) => stepsOf(job)).filter((step) => typeof step.run === 'string' && step.run.includes('scripts/verify.ts'));
  if (verifySteps.length !== 1) errors.push(`${file}: exactly one step may mention scripts/verify.ts, found ${verifySteps.length}`);
  errors.push(...aggregateErrors(file, workflow.jobs));
  return errors;
}

// Dependabot: weekly grouped updates for every ecosystem the repository uses, without automatic majors
// for Cargo and npm (OQ-06 section 2.1).
export function dependabotErrors(text: string): string[] {
  const file = '.github/dependabot.yml';
  let config: Json;
  try { config = parse(text, { uniqueKeys: true, prettyErrors: false }); } catch (error) {
    return [`${file}: invalid YAML: ${error instanceof Error ? error.message : error}`];
  }
  const errors: string[] = [];
  const updates: Json[] = Array.isArray(config?.updates) ? config.updates : [];
  for (const ecosystem of ['github-actions', 'cargo', 'npm']) {
    const entry = updates.find((item) => item?.['package-ecosystem'] === ecosystem);
    if (!entry) { errors.push(`${file}: missing the ${ecosystem} ecosystem`); continue; }
    if (entry.directory !== '/') errors.push(`${file}: ${ecosystem} must update the root directory`);
    if (entry.schedule?.interval !== 'weekly') errors.push(`${file}: ${ecosystem} updates must be weekly`);
    if (!isMap(entry.groups) || Object.keys(entry.groups).length === 0) errors.push(`${file}: ${ecosystem} updates must be grouped`);
    if (ecosystem !== 'github-actions') {
      const majors = Array.isArray(entry.ignore) && entry.ignore.some((rule: Json) => rule?.['dependency-name'] === '*' && Array.isArray(rule['update-types']) && rule['update-types'].includes('version-update:semver-major'));
      if (!majors) errors.push(`${file}: ${ecosystem} must not propose major updates automatically`);
    }
  }
  return errors;
}

export function workflowFileErrors(base: string, pnpm: string): string[] {
  const errors: string[] = [];
  const directory = resolve(base, '.github/workflows');
  const names = readdirSync(directory).filter((item) => /\.ya?ml$/.test(item)).sort();
  if (!names.includes('ci.yml')) errors.push('.github/workflows/ci.yml is missing');
  for (const name of names) {
    const file = `.github/workflows/${name}`;
    const text = readFileSync(resolve(directory, name), 'utf8');
    errors.push(...(name === 'ci.yml' ? ciWorkflowErrors(text, pnpm) : workflowErrors(file, text)));
  }
  errors.push(...dependabotErrors(readFileSync(resolve(base, '.github/dependabot.yml'), 'utf8')));
  return errors;
}
