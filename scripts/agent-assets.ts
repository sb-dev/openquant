import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Checks the assets of packages/agents (OQ-03 sections 3, 4 and 6; OQ-06 section 8): the behaviour-bundle manifest,
// the shipped procedures and role schemas, the draft method notes that stay outside the bundle, the synthetic fixture
// policy, the evaluation cases and the offline agent fixtures.
//
// The bundle is an exact allowlist of paths and content hashes (OQ-03 section 3). bundle.manifest.json lists what
// ships. This check verifies every listed file and hash, requires the set of files in the bundle directories to equal
// the listed set, and fails a manifest that lists an evaluation file, an expected answer, a development script, a
// method note, a private snapshot or a path outside the shipped file classes. The derived result schemas are
// checked by the package build (tools/generate.ts), which needs the schema bundler.
// Use the checked repository inventory. Do not follow untrusted filesystem paths.

const agents = 'packages/agents';
const fixtureRoot = 'fixtures/agent-results';
const oq03 = 'docs/specs/03-model-backed-execution-spec.md';
const specFiles: Record<string, string> = {
  'OQ-01': 'docs/specs/01-product-design-spec.md',
  'OQ-02': 'docs/specs/02-trading-domain-and-evaluation-spec.md',
  'OQ-03': oq03,
  'OQ-04': 'docs/specs/04-ink-ux-ui-spec.md',
  'OQ-05': 'docs/specs/05-system-architecture-and-data-spec.md',
  'OQ-06': 'docs/specs/06-engineering-delivery-and-operations-spec.md',
  'OQ-07': 'docs/specs/07-open-source-project-organisation-spec.md',
};
const ruleOrigins = ['primary_checked', 'summary_claim_unverified', 'summariser_recommendation'];
const findingSources = ['deterministic_check', 'model_judgement'];
const scopes = ['seed', 'needs_operator', 'out_of_scope'];
const splits = ['authoring', 'tuning', 'fresh'];
const kinds = ['behaviour', 'parser'];
const escalations = ['affects_executable_rule', 'required_evidence'];
// The lifecycle transitions that finding treatment can block in S1 (OQ-02 section 4).
const transitions = ['DRAFT_TO_EVALUATING', 'EVALUATING_TO_PAPER'];
const ruleHeader = '| Rule | Statement | Origin | Category | Scope | Summary page | Corrections and limits |';
const noteSections = ['## Scope', '## Rules', '## Conflicts and adaptations', '## Limits'];
const procedureSections = ['## Role and authority', '## Inputs', '## Method selection', '## Workflow', '## Output', '## Limits'];
const categoryHeader = '| Category | Defect or concern covered |';
const procedureCategoryHeader = '| Category | What to check |';

// Coverage tags mirror the proposal and criticism cases in OQ-03 §§4 and 6. Update them together.
const pilotSkills: Record<string, {
  role: string; prefix: string;
  fresh: string[]; required: string[]; optional: string[];
}> = {
  'strategy-formulation': {
    role: 'proposer', prefix: 'SF',
    fresh: ['valid_seed', 'valid_revision', 'valid_new_family', 'altered_comparison_conditions', 'unsupported_operator', 'unresolved_executable_assumption', 'holdout_leakage'],
    required: ['missing_parent_reference', 'missing_source_reference'],
    optional: ['source_injection', 'diagnostics_feedback', 'out_of_scope_method', 'rule_origin_labelling'],
  },
  'strategy-critique': {
    role: 'critic', prefix: 'SC',
    fresh: ['row_based_alignment', 'same_close_signal_fill', 'uncertain_stop_ordering', 'changed_evaluation_window', 'positive_control'],
    required: ['unregistered_candidate', 'unknown_category'],
    optional: ['source_injection', 'approval_attempt', 'policy_threshold_advice'],
  },
};
// The S1 role request and result schemas (OQ-03 sections 3 and 4). Exactly these files, beside the README.
const roleSchemas = [
  'role-common.schema.json',
  'strategy-formulation.request.schema.json',
  'strategy-formulation.result.schema.json',
  'strategy-critique.request.schema.json',
  'strategy-critique.result.schema.json',
];
const proposalKinds = ['seed_translation', 'controlled_revision', 'new_family', 'none'];
const ownerValidations = ['registered', 'rejected', 'not_reached'];

// The package files that always exist, beside the bundle files and the draft method notes.
const packageFiles = [
  'README.md', 'package.json', 'tsconfig.json', 'tsconfig.test.json', 'turbo.json', 'vitest.config.ts', 'test-reporter.ts',
  'bundle.manifest.json', 'schemas/README.md', 'src/methods/sources.json', 'evals/fixture-policy.json',
];
// The directories of code that is not part of the bundle. Each is listed here, and only .ts files are accepted in them.
const codeDirectories = ['src', 'test', 'tools', 'dev'];
// The bundle directories: every file in them ships, except the schema README, so every file must be in the manifest.
const bundleDirectories = ['schemas', 'src/skills'];
const manifestKeys = ['derived', 'files', 'format', 'id', 'methods', 'skills', 'version'];
const skillKeys = ['id', 'procedure', 'request_contract', 'result_contract', 'role', 'version'];
const manifestFormat = 'openquant-agent-bundle/1';
const updateHint = 'run pnpm --filter @openquant/agents run bundle:update and review the manifest change';
// A method rule identifier such as CHAN-07. The production bundle adopts no method note, so none may appear in it.
const methodRuleId = /\b[A-Z]{3,}-\d{2}\b/;

type Json = any;

// Why a path may not be a bundle file, or undefined when its class may ship (OQ-03 section 3).
export function bundlePathProblem(path: string): string | undefined {
  if (typeof path !== 'string' || path === '') return 'is not a path';
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.includes('\\')) return 'is not a relative path';
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return 'is not a canonical path inside the package';
  if (parts[0] === 'evals' || parts[0] === 'fixtures') return 'is an evaluation file';
  if (parts[0] === 'dev' || parts[0] === 'tools' || parts[0] === 'test' || path.endsWith('.ts')) return 'is a development script';
  if (path.startsWith('src/methods/')) return 'is a method note, which the baseline bundle does not adopt';
  if (/(?:^|[/._-])expected(?:[/._-]|$)/i.test(path)) return 'is an expected answer';
  if (/(?:^|[/._-])(?:snapshot|private|licensed)(?:[/._-]|$)/i.test(path)) return 'is a private snapshot';
  if (/^schemas\/[a-z][a-z0-9.-]*\.schema\.json$/.test(path)) return undefined;
  if (/^src\/skills\/[a-z][a-z0-9-]*\/procedure\.md$/.test(path)) return undefined;
  return 'is not a procedure or a role schema';
}

export function agentAssetErrors(base: string, files: Set<string>): string[] {
  const errors: string[] = [];
  const read = (path: string) => {
    if (!files.has(path)) throw new Error(`Missing agent asset: ${path}`);
    return readFileSync(resolve(base, path), 'utf8');
  };
  const json = (path: string): Json => {
    const content = read(path);
    try { return JSON.parse(content); }
    catch (error) { throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : error}`); }
  };
  const tryGroup = (label: string, run: () => void) => {
    try { run(); } catch (error) { errors.push(`Agent assets: ${label}: ${error instanceof Error ? error.message : error}`); }
  };
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  const sha = (path: string) => `sha256:${createHash('sha256').update(readFileSync(resolve(base, path))).digest('hex')}`;

  // Canonical vocabulary from OQ-03 §4.
  let categories: string[] = [];
  let outcomes: string[] = [];
  tryGroup('OQ-03', () => {
    const spec = read(oq03);
    const lines = spec.split('\n');
    const start = lines.indexOf(categoryHeader);
    if (start < 0) throw new Error('OQ-03 finding category table is missing');
    for (const line of lines.slice(start + 2)) {
      const match = /^\| `([a-z_]+)` \|/.exec(line);
      if (!match) break;
      categories.push(match[1]);
    }
    if (!categories.length) throw new Error('OQ-03 finding category table is empty');
    const outcome = /^\| Execution outcome \| (.+?)\.? \|$/m.exec(spec)?.[1];
    if (!outcome) throw new Error('OQ-03 execution outcome row is missing');
    outcomes = outcome.split(/,\s*(?:or\s+)?|\s+or\s+/).map((item) => item.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean);
    for (const token of [...ruleOrigins, ...findingSources, ...Object.keys(pilotSkills)]) {
      if (!spec.includes(`\`${token}\``)) errors.push(`OQ-03 does not define ${token}`);
    }
  });

  const sameSet = (label: string, actual: string[], ordered: boolean) => {
    const missing = categories.filter((item) => !actual.includes(item));
    const unexpected = actual.filter((item) => !categories.includes(item));
    const reordered = ordered && !missing.length && !unexpected.length && actual.join() !== categories.join();
    if (missing.length || unexpected.length || reordered || new Set(actual).size !== actual.length) {
      errors.push(`${label} categories differ from OQ-03 §4: missing [${missing.join(', ')}]; unexpected [${unexpected.join(', ')}]${reordered ? '; order differs' : ''}`);
    }
  };

  // The behaviour-bundle manifest (OQ-03 section 3): exact paths and content hashes, nothing recursive.
  const shipped = new Set<string>();
  const manifestPath = `${agents}/bundle.manifest.json`;
  let manifestSkills: Json[] = [];
  tryGroup('bundle manifest', () => {
    const manifest = json(manifestPath);
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) throw new Error('the manifest is not an object');
    const keys = Object.keys(manifest).sort();
    if (keys.join() !== manifestKeys.join()) errors.push(`Bundle manifest keys must be exactly [${manifestKeys.join(', ')}], found [${keys.join(', ')}]`);
    if (manifest.format !== manifestFormat) errors.push(`Bundle manifest format must be ${manifestFormat}`);
    if (!/^[a-z][a-z0-9-]*$/.test(manifest.id ?? '') || !Number.isInteger(manifest.version) || manifest.version < 1) errors.push('Bundle manifest needs an id and a positive integer version');
    if (!Array.isArray(manifest.methods) || manifest.methods.length) errors.push('Bundle manifest methods must be an empty list: the baseline bundle adopts no method note');

    manifestSkills = Array.isArray(manifest.skills) ? manifest.skills : [];
    if (manifestSkills.map((skill) => skill?.id).join() !== Object.keys(pilotSkills).join()) errors.push(`Bundle manifest skills must be exactly [${Object.keys(pilotSkills).join(', ')}], in this order`);
    for (const skill of manifestSkills) {
      const definition = pilotSkills[skill?.id];
      if (!definition) continue;
      const id = skill.id;
      if (Object.keys(skill).sort().join() !== skillKeys.join() || skill.version !== '1' || skill.role !== definition.role
        || skill.procedure !== `src/skills/${id}/procedure.md` || skill.request_contract !== `${id}.request/1` || skill.result_contract !== `${id}.result/1`) {
        errors.push(`Invalid bundle manifest skill: ${id}`);
      }
    }

    const listed: Json[] = Array.isArray(manifest.files) ? manifest.files : [];
    if (!listed.length) errors.push('Bundle manifest lists no file');
    const paths = listed.map((entry) => entry?.path);
    if (paths.some((path, index) => index > 0 && !(String(paths[index - 1]) < String(path)))) errors.push('Bundle manifest files must be sorted by path, each path once');
    for (const entry of listed) {
      const path = entry?.path;
      if (typeof entry !== 'object' || entry === null || Object.keys(entry).sort().join() !== 'path,sha256') { errors.push(`Invalid bundle manifest file entry: ${path ?? JSON.stringify(entry)}`); continue; }
      const problem = bundlePathProblem(path);
      if (problem) { errors.push(`Bundle file ${problem}: ${path}`); continue; }
      shipped.add(path);
      const full = `${agents}/${path}`;
      if (!files.has(full)) { errors.push(`Bundle file is missing: ${full}`); continue; }
      if (!/^sha256:[0-9a-f]{64}$/.test(entry.sha256 ?? '')) { errors.push(`Bundle file has no SHA-256 digest: ${path}`); continue; }
      if (sha(full) !== entry.sha256) errors.push(`Bundle file changed after the manifest recorded it: ${full}; ${updateHint}`);
    }
    for (const skill of manifestSkills) {
      if (pilotSkills[skill?.id] && !shipped.has(skill.procedure)) errors.push(`The procedure of ${skill.id} is not a bundle file`);
    }

    const derived: Json[] = Array.isArray(manifest.derived) ? manifest.derived : [];
    const wanted = manifestSkills.map((skill) => skill?.result_contract);
    if (derived.map((entry) => entry?.name).join() !== wanted.join()
      || derived.some((entry) => typeof entry !== 'object' || entry === null || Object.keys(entry).sort().join() !== 'name,sha256' || !/^sha256:[0-9a-f]{64}$/.test(entry.sha256 ?? ''))) {
      errors.push(`Bundle manifest derived entries must name the result contracts [${wanted.join(', ')}], each with a SHA-256 digest`);
    }
  });
  // Every file in a bundle directory ships, so every one must be listed. The schema README documents the schemas.
  for (const path of [...files].sort()) {
    if (!path.startsWith(`${agents}/`)) continue;
    const relative = path.slice(agents.length + 1);
    if (relative === 'schemas/README.md') continue;
    if (bundleDirectories.some((directory) => relative.startsWith(`${directory}/`)) && !shipped.has(relative)) {
      errors.push(`Shipped file is not listed in the bundle manifest: ${path}; list it only if it is a procedure or a role schema, and ${updateHint}`);
    }
  }

  // Source registry and method notes. They are draft material outside the bundle.
  const prefixes = new Map<string, Json>();
  const rules = new Map<string, { category: string; origin: string }>();
  const required = new Set<string>([
    ...packageFiles.map((name) => `${agents}/${name}`),
    ...roleSchemas.map((name) => `${agents}/schemas/${name}`),
    ...Object.keys(pilotSkills).flatMap((skill) => [
      `${agents}/src/skills/${skill}/procedure.md`,
      `${agents}/evals/${skill}/fixtures/dataset.json`,
    ]),
  ]);
  tryGroup('source registry', () => {
    if (!files.has(`${agents}/src/methods/sources.json`)) return;
    const registry = json(`${agents}/src/methods/sources.json`);
    if (!text(registry.description) || !Array.isArray(registry.sources) || !registry.sources.length) throw new Error('Invalid source registry');
    const ids = new Set<string>();
    for (const source of registry.sources) {
      const id = source?.id;
      const summary = source?.summary ?? {};
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id ?? '') || !/^[A-Z]{3,}$/.test(source.rule_prefix ?? '')
        || !['author', 'title', 'edition'].every((key) => text(source[key]))
        || source.note !== `${agents}/src/methods/${id}.md` || !Array.isArray(source.primary_pages_checked)
        || !['kind', 'export_method', 'document_revision', 'locator'].every((key) => text(summary[key]))
        || summary.media_type !== 'application/pdf' || !/^\d{4}-\d{2}-\d{2}$/.test(summary.received ?? '')) {
        errors.push(`Invalid source record: ${id ?? '(missing id)'}`);
        continue;
      }
      if (ids.has(id)) errors.push(`Duplicate source: ${id}`);
      ids.add(id);
      if (prefixes.has(source.rule_prefix)) errors.push(`Duplicate rule prefix: ${source.rule_prefix}`);
      prefixes.set(source.rule_prefix, source);
      if (!/^[0-9a-f]{64}$/.test(summary.sha256 ?? '') || !Number.isInteger(summary.bytes) || summary.bytes <= 0
        || !Number.isInteger(summary.pages) || summary.pages <= 0) errors.push(`Invalid summary digest: ${id}`);
      required.add(source.note);
    }
  });
  for (const [prefix, source] of prefixes) {
    if (!files.has(source.note)) continue;
    tryGroup(source.note, () => {
      const note = read(source.note);
      const headings = note.split('\n').filter((line) => line.startsWith('## '));
      if (headings.join('\n') !== noteSections.join('\n')) errors.push(`Method note sections differ from [${noteSections.join(', ')}]: ${source.note}`);
      const lines = note.split('\n');
      const start = lines.indexOf(ruleHeader);
      if (start < 0 || lines[start + 1] !== '| --- | --- | --- | --- | --- | --- | --- |') { errors.push(`Method note has no rules: ${source.note}`); return; }
      // A primary_checked rule needs a complete record of the primary pages checked (OQ-03 §3).
      const checked = new Set<string>();
      for (const item of source.primary_pages_checked) {
        const complete = /^[A-Z]{3,}-\d{2}$/.test(item?.rule ?? '') && ['locator', 'pages', 'checked_by'].every((key) => text(item[key]))
          && /^\d{4}-\d{2}-\d{2}$/.test(item.checked_on ?? '');
        if (complete) checked.add(item.rule);
        else errors.push(`Invalid primary page record in ${source.note}: ${item?.rule ?? '(missing rule)'} needs locator, pages, checked_on and checked_by`);
      }
      let expected = 1;
      for (const line of lines.slice(start + 2)) {
        if (!line.startsWith('|')) break;
        const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
        const id = /^`([A-Z]{3,}-\d{2})`$/.exec(cells[0] ?? '')?.[1] ?? cells[0];
        if (cells.length !== 7 || cells.some((cell) => !cell)) { errors.push(`Invalid rule row in ${source.note}: ${id}`); continue; }
        if (!id.startsWith(`${prefix}-`)) errors.push(`Rule ${id} does not use source prefix ${prefix}`);
        else if (id !== `${prefix}-${String(expected).padStart(2, '0')}`) errors.push(`Rule ${id} is out of sequence in ${source.note}`);
        expected += 1;
        if (rules.has(id)) errors.push(`Duplicate rule: ${id}`);
        const value = (cell: string) => /^`([a-z_]+)`$/.exec(cell)?.[1] ?? cell;
        const [origin, category, scope] = [value(cells[2]), value(cells[3]), value(cells[4])];
        if (!ruleOrigins.includes(origin)) errors.push(`Unknown rule_origin ${origin} for ${id}`);
        if (origin === 'primary_checked' && !checked.has(id)) errors.push(`Rule ${id} claims primary_checked without a recorded primary page check`);
        if (categories.length && !categories.includes(category)) errors.push(`Unknown category ${category} for ${id}`);
        if (!scopes.includes(scope)) errors.push(`Unknown scope ${scope} for ${id}`);
        const pages = /^p(\d+)(?:–p(\d+))?(?:, p(\d+)(?:–p(\d+))?)*$/.test(cells[5]) ? [...cells[5].matchAll(/\d+/g)].map(Number) : null;
        if (!pages || pages.some((page) => page < 1 || page > source.summary.pages)) errors.push(`Invalid summary page for ${id}: ${cells[5]}`);
        rules.set(id, { category, origin });
      }
      if (expected === 1) errors.push(`Method note has no rules: ${source.note}`);
    });
  }

  // Exact layout. A file is one of the package files, a bundle file, a draft method note, a source file in a code
  // directory, or part of the explicitly listed non-bundle directories. The bundle directories report their own errors.
  for (const path of files) {
    if (!path.startsWith(`${agents}/`)) continue;
    const relative = path.slice(agents.length + 1);
    if (required.has(path)) continue;
    if (bundleDirectories.some((directory) => relative.startsWith(`${directory}/`)) && relative !== 'schemas/README.md') {
      if (/^src\/skills\/[^/]+\/procedure\.md$/.test(relative) || /^schemas\/[^/]+\.schema\.json$/.test(relative) || shipped.has(relative)) continue;
    }
    const directory = relative.split('/')[0];
    const code = codeDirectories.includes(directory) && !relative.startsWith('src/skills/') && !relative.startsWith('src/methods/') && /\.ts$/.test(relative);
    if (!code) errors.push(`Unexpected agent asset: ${path}`);
  }
  for (const path of required) if (!files.has(path)) errors.push(`Missing agent asset: ${path}`);

  // Shipped text must not reveal evaluation material or depend on links or quotations, and the draft method notes
  // keep the same rules. A schema pattern or JSON text can hold `](` without being a link. Code is not shipped text.
  for (const path of [...files].filter((item) => item.startsWith(`${agents}/src/`) || item.startsWith(`${agents}/schemas/`))) {
    if (path.endsWith('.ts')) continue;
    tryGroup(path, () => {
      const content = read(path);
      const markdown = path.endsWith('.md');
      if (path.startsWith(`${agents}/src/`)) {
        if (/\bS[FC]-\d{2}\b|evals\/|fixtures\/agent-results/.test(content)) errors.push(`Runtime asset references evaluation material: ${path}`);
        if (markdown && /\]\(/.test(content)) errors.push(`Runtime asset contains a link: ${path}`);
      }
      if (markdown && /^\s*>/m.test(content)) errors.push(`Blockquote not allowed in agent asset ${path}: paraphrase and cite`);
      if (path.endsWith('.schema.json')) json(path);
    });
  }

  // Procedures: the shipped, spec-derived text. No method rule, no draft marker, the reviewed sections, and an
  // Output section that names every field of the role result schema, so the instructions cannot drift from it.
  for (const [skill, definition] of Object.entries(pilotSkills)) {
    const path = `${agents}/src/skills/${skill}/procedure.md`;
    if (!files.has(path)) continue;
    tryGroup(path, () => {
      const content = read(path);
      const front = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1];
      if (front !== `skill: ${skill}\nrole: ${definition.role}\nversion: 1\nbundle: baseline`) errors.push(`Invalid procedure metadata: ${path}`);
      const headings = content.split('\n').filter((line) => line.startsWith('## '));
      const expectedSections = definition.role === 'critic'
        ? [...procedureSections.slice(0, 3), '## Finding categories', ...procedureSections.slice(3)]
        : procedureSections;
      if (headings.join('\n') !== expectedSections.join('\n')) errors.push(`Procedure sections differ from [${expectedSections.join(', ')}]: ${path}`);
      const cited = content.match(new RegExp(methodRuleId, 'g'));
      if (cited) errors.push(`Procedure cites a method rule, which the baseline bundle does not adopt: ${path}: ${[...new Set(cited)].join(', ')}`);
      if (/\bstatus: draft\b/.test(content)) errors.push(`Procedure is marked as a draft: ${path}`);
      if (definition.role === 'critic') {
        const lines = content.split('\n');
        const start = lines.indexOf(procedureCategoryHeader);
        if (start < 0) { errors.push(`Critic procedure category table is missing: ${path}`); return; }
        const listed: string[] = [];
        for (const line of lines.slice(start + 2)) {
          const match = /^\| `([a-z_]+)` \|/.exec(line);
          if (!match) break;
          listed.push(match[1]);
        }
        if (categories.length) sameSet('Critic procedure', listed, true);
      }
      // Drift guard: every property of the role result schema is named in backticks in the Output section.
      const schemaPath = `${agents}/schemas/${skill}.result.schema.json`;
      if (!files.has(schemaPath)) return;
      const schema = json(schemaPath);
      const names = new Set<string>(Object.keys(schema.properties ?? {}));
      for (const definitionSchema of Object.values<Json>(schema.$defs ?? {})) for (const name of Object.keys(definitionSchema?.properties ?? {})) names.add(name);
      const output = /\n## Output\n([\s\S]*?)(?=\n## |$)/.exec(content)?.[1] ?? '';
      for (const name of [...names].sort()) {
        if (!output.includes(`\`${name}\``)) errors.push(`Procedure Output section does not describe the result field \`${name}\`: ${path}`);
      }
    });
  }

  // Synthetic fixture policy: one row per category and lifecycle transition (OQ-02 section 4).
  let treatments: Record<string, Record<string, { default: string; escalate_when: string[] }>> = {};
  tryGroup('fixture policy', () => {
    if (!files.has(`${agents}/evals/fixture-policy.json`)) return;
    const policy = json(`${agents}/evals/fixture-policy.json`);
    if (policy.synthetic !== true || !text(policy.purpose)) errors.push('Fixture policy must be marked synthetic and state its purpose');
    if (JSON.stringify(policy.transitions) !== JSON.stringify(transitions)) errors.push(`Fixture policy transitions must be exactly [${transitions.join(', ')}]`);
    const entries = policy.treatments ?? {};
    if (categories.length) sameSet('Fixture policy', Object.keys(entries), false);
    for (const [category, byTransition] of Object.entries<Json>(entries)) {
      if (Object.keys(byTransition ?? {}).join() !== transitions.join()) { errors.push(`Fixture policy needs one treatment per transition [${transitions.join(', ')}] for ${category}`); continue; }
      treatments[category] = {};
      for (const transition of transitions) {
        const treatment = byTransition[transition];
        const escalate = treatment?.escalate_when ?? [];
        if (!['blocking', 'advisory'].includes(treatment?.default) || !Array.isArray(escalate)) { errors.push(`Invalid treatment for ${category} at ${transition}`); continue; }
        for (const condition of escalate) if (!escalations.includes(condition)) errors.push(`Unknown applicability condition ${condition} for ${category}`);
        if (treatment.default === 'blocking' && escalate.length) errors.push(`Blocking treatment cannot escalate: ${category}`);
        // In S1 no finding category blocks DRAFT_TO_EVALUATING (OQ-02 section 4).
        if (transition === 'DRAFT_TO_EVALUATING' && (treatment.default !== 'advisory' || escalate.length)) errors.push(`No finding category blocks DRAFT_TO_EVALUATING in S1: ${category}`);
        treatments[category][transition] = { default: treatment.default, escalate_when: escalate };
      }
    }
  });

  // Offline agent fixtures: labelled synthetic responses and the shared context. None is recorded before S1 acceptance.
  const fixtureResponses = new Map<string, string>();
  tryGroup('offline agent fixtures', () => {
    for (const path of [...files].filter((item) => item.startsWith(`${fixtureRoot}/`)).sort()) {
      const relative = path.slice(fixtureRoot.length + 1);
      if (relative === 'README.md') continue;
      const suite = /^([^/]+)\/[^/]+\.json$/.exec(relative)?.[1];
      if (/^context\.[a-z0-9-]+\.json$/.test(relative)) {
        const context = json(path);
        if (context.label !== 'synthetic') errors.push(`Agent fixture must be labelled synthetic until a real model has produced it: ${path}`);
        continue;
      }
      if (!suite || !pilotSkills[suite]) { errors.push(`Unexpected agent fixture: ${path}`); continue; }
      const fixture = json(path);
      if (fixture.label !== 'synthetic') errors.push(`Agent fixture must be labelled synthetic until a real model has produced it: ${path}`);
      if (fixture.suite !== suite || `${fixture.id}.json` !== relative.slice(suite.length + 1)) errors.push(`Agent fixture suite and id must match its path: ${path}`);
      if (!text(fixture.purpose)) errors.push(`Agent fixture states no purpose: ${path}`);
      if (typeof fixture.request !== 'object' || fixture.request === null) errors.push(`Agent fixture has no request recipe: ${path}`);
      const refused = fixture.assembly?.outcome === 'refused';
      const responses = ['response', 'response_text', 'response_pad'].filter((key) => key in fixture);
      if (refused ? responses.length : responses.length !== 1 || typeof fixture.expect !== 'object' || fixture.expect === null) {
        errors.push(`Agent fixture needs a refusal and no response, or exactly one response and an expectation: ${path}`);
      }
      fixtureResponses.set(path, suite);
    }
  });

  // Evaluation case descriptions.
  const headings = new Map<string, Set<string>>();
  const sectionExists = (spec: string, section: string) => {
    if (!headings.has(spec)) {
      headings.set(spec, new Set([...read(specFiles[spec]).matchAll(/^#{2,3} (\d+(?:\.\d+)?)\.?\s/gm)].map((match) => match[1])));
    }
    return headings.get(spec)!.has(section);
  };
  const ids = new Set<string>();
  for (const [skill, definition] of Object.entries(pilotSkills)) {
    const path = `${agents}/evals/${skill}/fixtures/dataset.json`;
    if (!files.has(path)) continue;
    tryGroup(path, () => {
      const dataset = json(path);
      if (dataset.skill !== skill || dataset.role !== definition.role || !Array.isArray(dataset.cases) || !dataset.cases.length) {
        errors.push(`Invalid dataset header: ${path}`);
        return;
      }
      const allowedTags = [...definition.fresh, ...definition.required, ...definition.optional];
      const covered = new Map<string, Set<string>>();
      const findingCategories = new Set<string>();
      for (const item of dataset.cases) {
        const id = item?.id;
        const invalid = (field: string) => errors.push(`Invalid case ${id ?? '(missing id)'} in ${path}: ${field}`);
        if (!new RegExp(`^${definition.prefix}-\\d{2}$`).test(id ?? '')) { invalid('id'); continue; }
        if (ids.has(id)) errors.push(`Duplicate case: ${id}`);
        ids.add(id);
        if (!splits.includes(item.split)) errors.push(`Case ${id} uses unknown split ${item.split}`);
        if (item.split === 'fresh' ? typeof item.consumed !== 'boolean' : 'consumed' in item) errors.push(`Case ${id}: consumed is required for fresh cases and only valid for them`);
        if (!kinds.includes(item.kind)) invalid('kind');
        for (const field of ['purpose', 'input', 'frozen_context']) if (!text(item[field])) invalid(field);
        if (!Array.isArray(item.requirements) || !item.requirements.length) invalid('requirements');
        for (const reference of item.requirements ?? []) {
          const spec = /^(OQ-0[1-7]) §(\d+(?:\.\d+)?)$/.exec(reference);
          const acceptance = /^(A(0[1-9]|1[0-8])|R(0[1-9]|10))$/.test(reference);
          if (spec ? !sectionExists(spec[1], spec[2]) : !acceptance) errors.push(`Case ${id} references missing requirement ${reference}`);
        }
        if (!Array.isArray(item.method_refs)) invalid('method_refs');
        for (const rule of item.method_refs ?? []) if (!rules.has(rule)) errors.push(`Case ${id} references unknown rule ${rule}`);
        if (!Array.isArray(item.covers)) invalid('covers');
        for (const tag of item.covers ?? []) {
          if (!allowedTags.includes(tag)) errors.push(`Case ${id} uses unknown coverage tag ${tag}`);
          if (!covered.has(tag)) covered.set(tag, new Set());
          covered.get(tag)!.add(item.split);
        }
        if (!Array.isArray(item.recorded_responses)) invalid('recorded_responses');
        for (const response of item.recorded_responses ?? []) {
          if (typeof response !== 'string' || !response.startsWith(`${fixtureRoot}/`) || !files.has(response)) errors.push(`Case ${id} references untracked recorded response ${response}`);
          else if (fixtureResponses.get(response) !== skill) errors.push(`Case ${id} references a response of another suite: ${response}`);
        }
        if (!Array.isArray(item.permitted_tools)) invalid('permitted_tools');
        else if (item.permitted_tools.length) errors.push(`Case ${id} permits tools before S3: ${item.permitted_tools.join(', ')}`);
        const expected = item.expected ?? {};
        if (!['dispatched', 'blocked_before_dispatch'].includes(expected.dispatch)) invalid('expected.dispatch');
        const blocked = expected.dispatch === 'blocked_before_dispatch';
        if (blocked ? expected.attempt_outcome !== null : !outcomes.includes(expected.attempt_outcome)) errors.push(`Case ${id} uses unknown attempt outcome ${expected.attempt_outcome}`);
        for (const field of ['warnings', 'diagnostics']) if (!Array.isArray(expected[field])) invalid(`expected.${field}`);
        const completed = expected.attempt_outcome === 'completion';
        if (definition.role === 'proposer') {
          if (!proposalKinds.includes(expected.proposal_kind)) invalid('expected.proposal_kind');
          if (!ownerValidations.includes(expected.owner_validation)) invalid('expected.owner_validation');
          else if (!completed && expected.owner_validation !== 'not_reached') errors.push(`Case ${id}: owner validation requires a completed attempt`);
          if (!Array.isArray(expected.must_include)) invalid('expected.must_include');
        } else {
          if (!Array.isArray(expected.findings) || !Array.isArray(expected.tolerated)) { invalid('expected.findings'); continue; }
          if (!completed && expected.findings.length) errors.push(`Case ${id}: findings require a completed attempt`);
          for (const finding of expected.findings) {
            const category = finding?.category;
            if (!categories.includes(category)) { errors.push(`Case ${id} uses unknown finding category ${category}`); continue; }
            findingCategories.add(category);
            if (!findingSources.includes(finding.finding_source)) errors.push(`Case ${id} uses unknown finding_source ${finding.finding_source}`);
            for (const field of ['location', 'evidence']) if (!text(finding[field])) invalid(`expected.findings.${field}`);
            if (!Array.isArray(finding.affected_elements)) invalid('expected.findings.affected_elements');
            const applicability = finding.applicability ?? [];
            if (!Array.isArray(applicability) || applicability.some((condition: string) => !escalations.includes(condition))) invalid('expected.findings.applicability');
            else if (Array.isArray(finding.affected_elements) && applicability.includes('affects_executable_rule') !== finding.affected_elements.length > 0) errors.push(`Case ${id}: affects_executable_rule must hold exactly when affected_elements is non-empty`);
            // Treatment is stated per lifecycle transition and follows the fixture policy for each (OQ-02 section 4).
            const stated = finding.treatment;
            if (typeof stated !== 'object' || stated === null || Object.keys(stated).join() !== transitions.join()) { invalid('expected.findings.treatment'); continue; }
            for (const transition of transitions) {
              const treatment = treatments[category]?.[transition];
              if (!treatment) continue;
              const computed = treatment.default === 'blocking' || applicability.some((condition: string) => treatment.escalate_when.includes(condition)) ? 'blocking' : 'advisory';
              if (stated[transition] !== computed) errors.push(`Case ${id} treatment for ${category} at ${transition} differs from fixture policy`);
            }
          }
          for (const category of expected.tolerated) {
            if (!categories.includes(category)) errors.push(`Case ${id} uses unknown finding category ${category}`);
            else if (transitions.some((transition) => treatments[category]?.[transition]?.default !== 'advisory')) errors.push(`Case ${id} tolerates non-advisory category ${category}`);
          }
        }
      }
      for (const tag of [...definition.fresh, ...definition.required]) {
        if (!covered.has(tag)) errors.push(`Uncovered required case in ${path}: ${tag}`);
        else if (definition.fresh.includes(tag) && !covered.get(tag)!.has('fresh')) errors.push(`Required case has no fresh case in ${path}: ${tag}`);
      }
      if (definition.role === 'critic') for (const category of categories) if (!findingCategories.has(category)) errors.push(`Uncovered finding category in ${path}: ${category}`);
    });
  }
  return errors;
}
