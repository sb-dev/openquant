import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isTomlTable, parseToml, type TomlTable, type TomlValue } from './s0.ts';

// Static checks of the deployable infrastructure files (OQ-06 section 3; OQ-05 sections 5 and 6). terraform, flyctl,
// wrangler and a Docker daemon are not needed: these checks read the files as text. They do not replace
// `terraform validate`, a Docker build or a deployment read-back; they keep the reviewed properties from drifting:
//
// - the environment profile (infra/environments/*.json) has a fixed shape that holds host names, app names, file
//   paths and the names of settings and secrets, never a value, and agrees with the Fly profiles, the Worker
//   configuration and the Terraform variables it names;
// - each Fly profile (infra/fly/*.toml) is the app it is named after, sets a Machine size and a restart policy, sets no
//   secret in [env], and has the service shape of its host: none for the batch host, the dispatch service for the
//   runner;
// - each Dockerfile pins every base image by digest and ends as a non-root user with no credential in ENV or ARG; the
//   engine image is a locked release build on the pinned Rust toolchain, and the runner image is on the pinned Node with
//   the pinned pnpm and the executor version that the Worker dispatches;
// - .dockerignore keeps history, dependencies and every credential file out of the build context;
// - Terraform pins its providers exactly, leaves the state backend to init, disables Hyperdrive caching, and holds no
//   literal identifier and no tracked variable file.
//
// Use the checked repository inventory. Do not follow untrusted filesystem paths.

type Json = any;

const environmentProfiles = ['infra/environments/staging.json'];
const engineDockerfile = 'apps/engine/Dockerfile';
const runnerDockerfile = 'apps/agent-runner/Dockerfile';
const terraformDirectory = 'infra/terraform';
const settingName = /^[A-Z][A-Z0-9_]*$/;
const terraformName = /^[a-z][a-z0-9_]*$/;
const hostName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const flyApp = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const repositoryPath = /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;
// A name that says it holds a credential. Such a name never takes a value in a tracked file.
const credentialName = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|_KEY_ID|PRIVATE_KEY)/i;

// The text without comments that start with `#` (Dockerfile, TOML lines, .dockerignore).
function lines(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
}

// --- Dockerfiles ---------------------------------------------------------------------------------------------------

// Dockerfile instructions with their continuation lines joined.
export function dockerInstructions(text: string): Array<{ keyword: string; args: string }> {
  const result: Array<{ keyword: string; args: string }> = [];
  let pending = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (pending === '' && (line === '' || line.startsWith('#'))) continue;
    if (pending !== '' && line.startsWith('#')) continue;
    const joined = pending === '' ? line : `${pending} ${line}`;
    if (joined.endsWith('\\')) { pending = joined.slice(0, -1).trim(); continue; }
    pending = '';
    const match = /^([A-Za-z]+)\s+([\s\S]*)$/.exec(joined);
    if (match) result.push({ keyword: match[1].toUpperCase(), args: match[2].trim() });
  }
  return result;
}

export function dockerfileErrors(file: string, text: string): string[] {
  const errors: string[] = [];
  const instructions = dockerInstructions(text);
  const stages: string[] = [];
  let user: string | undefined;
  for (const { keyword, args } of instructions) {
    if (keyword === 'FROM') {
      const image = args.replace(/^--platform=\S+\s+/, '').split(/\s+/)[0];
      if (!stages.includes(image) && !/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}$/.test(image)) {
        errors.push(`${file}: base image must name a tag and pin its digest (image:tag@sha256:<64 hex>): ${image}`);
      }
      const alias = /\bAS\s+([a-z0-9_-]+)$/i.exec(args)?.[1];
      if (alias) stages.push(alias);
      user = undefined;
    }
    if (keyword === 'USER') user = args.split(':')[0];
    if (keyword === 'ENV' || keyword === 'ARG') {
      for (const name of args.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)(?==|\s|$)/g)) {
        if (credentialName.test(name[1])) errors.push(`${file}: ${keyword} must not name a credential: ${name[1]}`);
      }
    }
  }
  if (user === undefined || user === 'root' || user === '0') errors.push(`${file}: the final stage must end with USER set to a user that is not root`);
  return errors;
}

export function engineDockerfileErrors(text: string, channel: string): string[] {
  const errors: string[] = [];
  const instructions = dockerInstructions(text);
  const from = instructions.filter((item) => item.keyword === 'FROM').map((item) => item.args);
  if (!from.some((args) => args.startsWith(`rust:${channel}-`))) errors.push(`${engineDockerfile}: the build stage must use the rust:${channel} image of rust-toolchain.toml`);
  const runs = instructions.filter((item) => item.keyword === 'RUN').map((item) => item.args);
  if (!runs.some((args) => /\bcargo build\b/.test(args) && /\s--release\b/.test(args) && /\s--locked\b/.test(args) && /--bin engine-batch\b/.test(args))) {
    errors.push(`${engineDockerfile}: engine-batch must be a locked release build (cargo build --release --locked ... --bin engine-batch): a release build refuses the test loopback mode`);
  }
  if (/DEBUG_ASSERTIONS|debug-assertions|\bcfg\(debug_assertions\)|--profile\s+dev\b/.test(text)) errors.push(`${engineDockerfile}: must not turn debug assertions on in the release build`);
  return errors;
}

export function runnerDockerfileErrors(text: string, pins: { node: string; pnpm: string; executor: string }): string[] {
  const errors: string[] = [];
  const instructions = dockerInstructions(text);
  const from = instructions.filter((item) => item.keyword === 'FROM').map((item) => item.args);
  if (from.length === 0 || !from.every((args) => args.startsWith(`node:${pins.node}-`))) errors.push(`${runnerDockerfile}: every stage must use the node:${pins.node} image of .node-version`);
  const runs = instructions.filter((item) => item.keyword === 'RUN').map((item) => item.args).join('\n');
  if (!new RegExp(`\\bpnpm@${pins.pnpm.replace(/\./g, '\\.')}\\b`).test(runs)) errors.push(`${runnerDockerfile}: must install pnpm@${pins.pnpm}, the packageManager version`);
  if (!/pnpm install --frozen-lockfile --ignore-scripts/.test(runs)) errors.push(`${runnerDockerfile}: must install the locked dependencies with pnpm install --frozen-lockfile --ignore-scripts`);
  const executors = [...runs.matchAll(/@anthropic-ai\/claude-code@(\S+)/g)].map((match) => match[1]);
  if (executors.length !== 1 || executors[0] !== pins.executor) errors.push(`${runnerDockerfile}: must install @anthropic-ai/claude-code@${pins.executor}, the AGENT_EXECUTOR_VERSION of apps/api/wrangler.jsonc, once; found ${executors.join(', ') || 'none'}`);
  const env = instructions.filter((item) => item.keyword === 'ENV').map((item) => item.args).join(' ');
  if (!new RegExp(`\\bAGENT_RUNNER_EXECUTOR_VERSION=${pins.executor.replace(/\./g, '\\.')}(?:\\s|$)`).test(env)) errors.push(`${runnerDockerfile}: must set AGENT_RUNNER_EXECUTOR_VERSION=${pins.executor}`);
  return errors;
}

// The entries that keep history, dependencies and credential files out of the build context.
export const requiredDockerignore: readonly string[] = ['.git', '**/node_modules', 'target', '**/.env', '**/.env.*', '**/.dev.vars', '**/.dev.vars.*', '**/*.pem', '**/*.key', '**/*.tfstate', '**/*.tfvars'];
export function dockerignoreErrors(text: string): string[] {
  const entries = lines(text);
  const errors = requiredDockerignore.filter((entry) => !entries.includes(entry)).map((entry) => `.dockerignore must exclude ${entry}`);
  for (const entry of entries) if (entry.startsWith('!')) errors.push(`.dockerignore must not re-include a path: ${entry}`);
  return errors;
}

// --- Fly profiles --------------------------------------------------------------------------------------------------

function table(value: TomlValue | undefined): TomlTable | undefined {
  return isTomlTable(value) ? value : undefined;
}
function tables(value: TomlValue | undefined): TomlTable[] {
  return Array.isArray(value) ? value.filter(isTomlTable) : [];
}

export function flyProfileErrors(file: string, text: string): string[] {
  let config: TomlTable;
  try { config = parseToml(text); } catch (error) { return [`${file}: ${error instanceof Error ? error.message : error}`]; }
  const errors: string[] = [];
  const stem = /([^/]+)\.toml$/.exec(file)?.[1] ?? '';
  if (config.app !== stem) errors.push(`${file}: app must be ${stem}, the name of the file`);
  if (typeof config.primary_region !== 'string' || !/^[a-z]{3}$/.test(config.primary_region)) errors.push(`${file}: must name one primary_region`);
  if ('build' in config) errors.push(`${file}: must not build: the delivery job deploys a pinned image by digest`);
  const vm = tables(config.vm);
  if (vm.length !== 1 || typeof vm[0].size !== 'string' || typeof vm[0].memory !== 'string') errors.push(`${file}: must set one [[vm]] with size and memory`);
  const restart = tables(config.restart);
  if (restart.length !== 1 || !['on-failure', 'always'].includes(String(restart[0].policy))) errors.push(`${file}: must set one [[restart]] policy (on-failure or always)`);
  const env = table(config.env) ?? {};
  for (const name of Object.keys(env)) if (credentialName.test(name)) errors.push(`${file}: [env] must not set ${name}: a credential is an app secret`);
  const services = tables(config.services);
  if (stem.endsWith('-engine-batch')) {
    if ('services' in config || 'http_service' in config) errors.push(`${file}: the batch host serves nothing: no [http_service] and no [[services]]`);
  } else if (stem.endsWith('-agent-runner')) {
    if ('http_service' in config) errors.push(`${file}: the runner declares its service as [[services]], not [http_service]`);
    const port = env.AGENT_RUNNER_PORT;
    if (services.length !== 1 || services[0].internal_port !== port) errors.push(`${file}: the runner needs one [[services]] whose internal_port is AGENT_RUNNER_PORT`);
    if (env.AGENT_RUNNER_HOST !== '0.0.0.0') errors.push(`${file}: AGENT_RUNNER_HOST must be 0.0.0.0, so that the Fly proxy reaches the service`);
    for (const service of services) {
      if (service.auto_stop_machines !== 'off' || service.auto_start_machines !== false) errors.push(`${file}: the runner's Machines run long attempts: auto_stop_machines = "off" and auto_start_machines = false`);
      const ports = tables(service.ports);
      if (ports.length === 0 || ports.some((item) => !Array.isArray(item.handlers) || !item.handlers.includes('tls'))) errors.push(`${file}: every port of the runner's service must terminate TLS`);
    }
  } else errors.push(`${file}: unknown Fly profile; the name must end with -engine-batch or -agent-runner`);
  return errors;
}

// --- Terraform -----------------------------------------------------------------------------------------------------

// HCL without comments (`#`, `//`, `/* */`); string literals are kept.
export function hclCode(text: string): string {
  return text.replace(/("(?:\\.|[^"\\\n])*")|#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, literal) => (literal === undefined ? ' ' : match));
}

// The body of the block whose `{` is at or after `from`, by brace count outside strings.
function blockBody(code: string, from: number): string {
  const open = code.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let at = open; at < code.length; at += 1) {
    const char = code[at];
    if (char === '"') {
      at += 1;
      while (at < code.length && code[at] !== '"') at += code[at] === '\\' ? 2 : 1;
    } else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, at);
    }
  }
  return code.slice(open + 1);
}

export interface TerraformVariable {
  name: string;
  sensitive: boolean;
}

export function terraformVariables(sources: Readonly<Record<string, string>>): TerraformVariable[] {
  const result: TerraformVariable[] = [];
  for (const text of Object.values(sources)) {
    const code = hclCode(text);
    for (const match of code.matchAll(/\bvariable\s+"([^"]+)"\s*\{/g)) {
      result.push({ name: match[1], sensitive: /\bsensitive\s*=\s*true\b/.test(blockBody(code, match.index)) });
    }
  }
  return result;
}

export function terraformErrors(sources: Readonly<Record<string, string>>): string[] {
  const errors: string[] = [];
  const files = Object.keys(sources).sort();
  if (files.length === 0) return [`${terraformDirectory} must hold the Terraform configuration (*.tf)`];
  let requiredVersion = 0;
  let providerBlocks = 0;
  let backends = 0;
  for (const file of files) {
    const code = hclCode(sources[file]);
    requiredVersion += [...code.matchAll(/\brequired_version\s*=\s*"[^"]+"/g)].length;
    for (const match of code.matchAll(/\brequired_providers\s*\{/g)) {
      providerBlocks += 1;
      const body = blockBody(code, match.index);
      const providers = [...body.matchAll(/\b([a-z][a-z0-9_-]*)\s*=\s*\{/g)];
      if (providers.length === 0) errors.push(`${file}: required_providers lists no provider`);
      for (const provider of providers) {
        const entry = blockBody(body, provider.index);
        if (!/\bsource\s*=\s*"[a-z0-9-]+\/[a-z0-9-]+"/.test(entry)) errors.push(`${file}: provider ${provider[1]} must name its source`);
        const version = /\bversion\s*=\s*"([^"]*)"/.exec(entry)?.[1];
        if (version === undefined || !/^= ?\d+\.\d+\.\d+$/.test(version)) errors.push(`${file}: provider ${provider[1]} must pin one exact version (version = "= x.y.z"), found ${JSON.stringify(version ?? null)}`);
      }
    }
    for (const match of code.matchAll(/\bbackend\s+"[a-z0-9_]+"\s*\{/g)) {
      backends += 1;
      if (blockBody(code, match.index).trim() !== '') errors.push(`${file}: the backend block must be empty; its settings come from terraform init -backend-config`);
    }
    for (const match of code.matchAll(/\bresource\s+"cloudflare_hyperdrive_config"\s+"([^"]+)"\s*\{/g)) {
      if (!/\bcaching\s*=\s*\{\s*disabled\s*=\s*true\s*\}/.test(blockBody(code, match.index))) errors.push(`${file}: Hyperdrive ${match[1]} must disable caching (caching = { disabled = true })`);
    }
    for (const match of code.matchAll(/"[0-9a-f]{32}"/gi)) errors.push(`${file}: a literal identifier is not allowed; take it from a variable: ${match[0]}`);
  }
  if (requiredVersion !== 1) errors.push(`${terraformDirectory} must set required_version once`);
  if (providerBlocks !== 1) errors.push(`${terraformDirectory} must declare required_providers once`);
  if (backends !== 1) errors.push(`${terraformDirectory} must declare one empty backend block, so that the state backend is configured at init`);
  return errors;
}

// --- Environment profiles ------------------------------------------------------------------------------------------

export interface ProfileContext {
  /** Tracked repository paths. */
  files: ReadonlySet<string>;
  /** The text of each Fly profile that the profile may name. */
  flyProfiles: Readonly<Record<string, string>>;
  /** The keys of `vars` in apps/api/wrangler.jsonc. */
  workerVariables: readonly string[];
  /** The secret names of apps/api/.dev.vars.example. */
  workerSecrets: readonly string[];
  terraformVariables: readonly TerraformVariable[];
}

function exactKeys(errors: string[], at: string, value: Json, keys: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) { errors.push(`${at} must be an object`); return false; }
  const actual = Object.keys(value);
  for (const key of actual) if (!keys.includes(key)) errors.push(`${at} must not have ${key}: a profile holds names only, never a value`);
  for (const key of keys) if (!actual.includes(key)) errors.push(`${at} must have ${key}`);
  return true;
}

function names(errors: string[], at: string, value: Json, pattern: RegExp): string[] {
  if (!Array.isArray(value)) { errors.push(`${at} must be a list of names`); return []; }
  for (const item of value) if (typeof item !== 'string' || !pattern.test(item)) errors.push(`${at} must hold names only, found ${JSON.stringify(item)}`);
  return value.filter((item): item is string => typeof item === 'string');
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((item, index) => item === [...b].sort()[index]);
}

export function environmentProfileErrors(file: string, profile: Json, context: ProfileContext): string[] {
  const errors: string[] = [];
  if (!exactKeys(errors, file, profile, ['schema', 'environment', 'hosts', 'cloudflare', 'fly'])) return errors;
  if (profile.schema !== 'openquant-environment/1') errors.push(`${file}: schema must be openquant-environment/1`);
  if (!['DEVELOPMENT', 'STAGING', 'PRODUCTION'].includes(profile.environment)) errors.push(`${file}: environment must be DEVELOPMENT, STAGING or PRODUCTION`);
  else if (!file.endsWith(`/${profile.environment.toLowerCase()}.json`)) errors.push(`${file}: environment ${profile.environment} does not match the file name`);
  if (typeof profile.hosts !== 'object' || profile.hosts === null || Array.isArray(profile.hosts)) errors.push(`${file}: hosts must map a role to a host name`);
  else for (const [role, host] of Object.entries(profile.hosts)) {
    if (!/^[a-z][a-z0-9_]*$/.test(role) || typeof host !== 'string' || !hostName.test(host)) errors.push(`${file}: hosts.${role} must be a host name (no scheme, port or path), found ${JSON.stringify(host)}`);
  }
  const seen = new Map<string, string>();
  const unique = (at: string, list: readonly string[]) => {
    for (const name of list) {
      const first = seen.get(name);
      if (first !== undefined) errors.push(`${file}: ${name} is listed twice (${first} and ${at})`);
      else seen.set(name, at);
    }
  };

  const fly = profile.fly;
  const apps: string[] = [];
  if (typeof fly !== 'object' || fly === null || Array.isArray(fly)) errors.push(`${file}: fly must map an app to its profile`);
  else for (const [app, entry] of Object.entries(fly as Record<string, Json>)) {
    const at = `${file}: fly.${app}`;
    apps.push(app);
    if (!flyApp.test(app)) errors.push(`${at}: not a Fly app name`);
    if (!exactKeys(errors, at, entry, ['config', 'dockerfile', 'settings', 'secrets', 'optional_secrets'])) continue;
    for (const key of ['config', 'dockerfile']) {
      if (typeof entry[key] !== 'string' || !repositoryPath.test(entry[key]) || !context.files.has(entry[key])) errors.push(`${at}.${key} must name a tracked file`);
    }
    const settings = names(errors, `${at}.settings`, entry.settings, settingName);
    const secrets = names(errors, `${at}.secrets`, entry.secrets, settingName);
    const optional = names(errors, `${at}.optional_secrets`, entry.optional_secrets, settingName);
    unique(`fly.${app}.settings`, settings);
    unique(`fly.${app}.secrets`, secrets);
    unique(`fly.${app}.optional_secrets`, optional);
    for (const name of settings) if (credentialName.test(name)) errors.push(`${at}.settings: ${name} names a credential; list it under secrets`);
    const text = context.flyProfiles[entry.config];
    if (text === undefined) continue;
    let config: TomlTable;
    try { config = parseToml(text); } catch { continue; }
    if (config.app !== app) errors.push(`${at}: ${entry.config} configures ${JSON.stringify(config.app)}, not ${app}`);
    const env = table(config.env) ?? {};
    for (const name of [...settings, ...secrets, ...optional]) if (name in env) errors.push(`${at}: ${name} is set in [env] of ${entry.config}; it is supplied on the app, never in a tracked file`);
  }
  for (const path of Object.keys(context.flyProfiles)) {
    const app = /([^/]+)\.toml$/.exec(path)?.[1] ?? '';
    if (app.startsWith(`openquant-${String(profile.environment).toLowerCase()}-`) && !apps.includes(app)) errors.push(`${file}: the Fly profile ${path} is not listed under fly`);
  }

  const cloudflare = profile.cloudflare;
  if (!exactKeys(errors, `${file}: cloudflare`, cloudflare, ['worker', 'terraform'])) return errors;
  const worker = cloudflare.worker;
  if (exactKeys(errors, `${file}: cloudflare.worker`, worker, ['config', 'variables', 'fly_apps', 'secrets'])) {
    if (worker.config !== 'apps/api/wrangler.jsonc') errors.push(`${file}: cloudflare.worker.config must be apps/api/wrangler.jsonc`);
    const variables = names(errors, `${file}: cloudflare.worker.variables`, worker.variables, settingName);
    const secrets = names(errors, `${file}: cloudflare.worker.secrets`, worker.secrets, settingName);
    unique('cloudflare.worker.variables', variables);
    unique('cloudflare.worker.secrets', secrets);
    if (!sameSet(variables, context.workerVariables)) errors.push(`${file}: cloudflare.worker.variables must equal the vars of apps/api/wrangler.jsonc: ${context.workerVariables.join(', ')}`);
    if (!sameSet(secrets, context.workerSecrets)) errors.push(`${file}: cloudflare.worker.secrets must equal the names of apps/api/.dev.vars.example: ${context.workerSecrets.join(', ')}`);
    if (typeof worker.fly_apps !== 'object' || worker.fly_apps === null || Array.isArray(worker.fly_apps)) errors.push(`${file}: cloudflare.worker.fly_apps must map a variable to a Fly app`);
    else for (const [variable, app] of Object.entries(worker.fly_apps)) {
      if (!variables.includes(variable)) errors.push(`${file}: cloudflare.worker.fly_apps.${variable} is not a Worker variable`);
      if (typeof app !== 'string' || !apps.includes(app)) errors.push(`${file}: cloudflare.worker.fly_apps.${variable} must name an app listed under fly, found ${JSON.stringify(app)}`);
    }
  }
  const terraform = cloudflare.terraform;
  if (exactKeys(errors, `${file}: cloudflare.terraform`, terraform, ['directory', 'variables', 'secret_variables', 'credentials'])) {
    if (terraform.directory !== terraformDirectory) errors.push(`${file}: cloudflare.terraform.directory must be ${terraformDirectory}`);
    const variables = names(errors, `${file}: cloudflare.terraform.variables`, terraform.variables, terraformName);
    const secret = names(errors, `${file}: cloudflare.terraform.secret_variables`, terraform.secret_variables, terraformName);
    unique('cloudflare.terraform.credentials', names(errors, `${file}: cloudflare.terraform.credentials`, terraform.credentials, settingName));
    const declared = context.terraformVariables.map((item) => item.name);
    if (!sameSet(variables, declared)) errors.push(`${file}: cloudflare.terraform.variables must equal the variables of ${terraformDirectory}: ${declared.join(', ')}`);
    const sensitive = context.terraformVariables.filter((item) => item.sensitive).map((item) => item.name);
    if (!sameSet(secret, sensitive)) errors.push(`${file}: cloudflare.terraform.secret_variables must equal the sensitive variables of ${terraformDirectory}: ${sensitive.join(', ')}`);
  }
  return errors;
}

// JSONC to JSON: comments outside strings are dropped.
function withoutJsonComments(text: string): string {
  return text.replace(/("(?:\\.|[^"\\\n])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match, literal) => (literal === undefined ? ' ' : match));
}

export function infrastructureErrors(base: string, files: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  const read = (path: string) => readFileSync(resolve(base, path), 'utf8');
  const guard = (label: string, run: () => void) => {
    try { run(); } catch (error) { errors.push(`Infrastructure: ${label}: ${error instanceof Error ? error.message : error}`); }
  };
  const tracked = [...files].sort();
  for (const path of [engineDockerfile, runnerDockerfile, '.dockerignore', ...environmentProfiles]) {
    if (!files.has(path)) errors.push(`Missing infrastructure file: ${path}`);
  }
  if (errors.length) return errors;

  let executor = '';
  let workerVariables: string[] = [];
  guard('apps/api/wrangler.jsonc', () => {
    const vars = JSON.parse(withoutJsonComments(read('apps/api/wrangler.jsonc'))).vars ?? {};
    workerVariables = Object.keys(vars);
    executor = String(vars.AGENT_EXECUTOR_VERSION ?? '');
  });
  guard('Dockerfiles', () => {
    for (const file of tracked.filter((path) => /(^|\/)Dockerfile$/.test(path))) errors.push(...dockerfileErrors(file, read(file)));
    const channel = /^channel\s*=\s*"([^"]+)"/m.exec(read('rust-toolchain.toml'))?.[1] ?? '';
    errors.push(...engineDockerfileErrors(read(engineDockerfile), channel));
    const pnpm = /^pnpm@(.+)$/.exec(JSON.parse(read('package.json')).packageManager ?? '')?.[1] ?? '';
    errors.push(...runnerDockerfileErrors(read(runnerDockerfile), { node: read('.node-version').trim(), pnpm, executor }));
    errors.push(...dockerignoreErrors(read('.dockerignore')));
  });
  const flyProfiles: Record<string, string> = {};
  guard('Fly profiles', () => {
    for (const file of tracked.filter((path) => /^infra\/fly\/[^/]+\.toml$/.test(path))) {
      flyProfiles[file] = read(file);
      errors.push(...flyProfileErrors(file, flyProfiles[file]));
    }
  });
  const sources: Record<string, string> = {};
  guard('Terraform', () => {
    for (const file of tracked.filter((path) => path.startsWith(`${terraformDirectory}/`))) {
      if (file.endsWith('.tf')) sources[file] = read(file);
      if (/\.tfvars(\.json)?$/.test(file) || /\.tfplan$/.test(file) || file.includes('/.terraform/')) errors.push(`${file}: Terraform variable files, plans and provider caches are not tracked`);
    }
    errors.push(...terraformErrors(sources));
  });
  guard('environment profiles', () => {
    const workerSecrets = read('apps/api/.dev.vars.example').split('\n').filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line)).map((line) => line.split('=')[0]);
    const context: ProfileContext = { files, flyProfiles, workerVariables, workerSecrets, terraformVariables: terraformVariables(sources) };
    for (const file of tracked.filter((path) => /^infra\/environments\/[^/]+\.json$/.test(path))) {
      if (!environmentProfiles.includes(file)) { errors.push(`${file}: an environment profile needs its checks in scripts/infrastructure.ts`); continue; }
      errors.push(...environmentProfileErrors(file, JSON.parse(read(file)), context));
    }
  });
  return errors;
}
