// A stand-in for the Claude Code CLI. It is never the real binary and calls no model: it reads a scenario file,
// records what it was given, and behaves as the scenario says. argv[2] is the scenario path; the rest is what the runner
// passed to the "CLI".
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const [, , scenarioPath, ...args] = process.argv;
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function record(entry) {
  if (scenario.log) appendFileSync(scenario.log, `${JSON.stringify(entry)}\n`);
}

if (args[0] === '--version') {
  record({ kind: 'version', env: { ...process.env }, cwd: process.cwd() });
  process.stdout.write(`${scenario.version ?? '2.1.325'} (Claude Code)\n`);
  process.exit(scenario.versionExit ?? 0);
}

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const stdin = Buffer.concat(chunks);
  const home = process.env.HOME ?? '';
  record({
    kind: 'run',
    args,
    env: { ...process.env },
    cwd: process.cwd(),
    stdinBytes: stdin.length,
    stdinSha256: `sha256:${createHash('sha256').update(stdin).digest('hex')}`,
    homeEntries: home ? safeList(home) : [],
    cwdEntries: safeList(process.cwd()),
    pid: process.pid,
  });
  behave(stdin);
});

function safeList(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

// The text of the result: one text for every run, or one per role module, chosen by the skill named in the system prompt.
function resultText() {
  if (scenario.resultByRole) {
    const prompt = args.find((argument) => argument.startsWith('--system-prompt=')) ?? '';
    for (const [skill, text] of Object.entries(scenario.resultByRole)) {
      if (prompt.includes(`skill: ${skill}`)) return text;
    }
  }
  return scenario.resultText ?? '';
}

function cliResult(overrides = {}) {
  const model = scenario.reportedModel ?? option('--model') ?? 'claude-opus-5-5';
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    api_error_status: null,
    stop_reason: 'end_turn',
    session_id: scenario.reportedSession ?? option('--session-id'),
    total_cost_usd: 0.0123456,
    usage: { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 5, output_tokens: 20 },
    modelUsage: { [model]: { outputTokens: 20, provider: 'firstParty' } },
    result: resultText(),
    ...overrides,
    ...(scenario.report ?? {}),
  };
}

// A large write to a pipe is asynchronous: exit only once it has been flushed, or the runner reads a truncated result.
function finish(text, code = 0) {
  process.stdout.write(text, () => process.exit(code));
}

function behave(stdin) {
  switch (scenario.behaviour) {
    case 'result': {
      const object = cliResult();
      for (const key of scenario.omit ?? []) delete object[key];
      if (scenario.stderr) process.stderr.write(scenario.stderr);
      finish(JSON.stringify(object), scenario.exitCode ?? 0);
      break;
    }
    case 'raw': {
      process.stdout.write(scenario.stdout ?? '');
      process.stderr.write(scenario.stderr ?? '');
      process.exit(scenario.exitCode ?? 0);
      break;
    }
    case 'echo-stdin': {
      // The result text is the request itself: the runner must hand the exact bytes over on standard input.
      finish(JSON.stringify(cliResult({ result: stdin.toString('utf8') })));
      break;
    }
    case 'dump-env': {
      finish(JSON.stringify(cliResult({ result: JSON.stringify({ env: { ...process.env } }) })));
      break;
    }
    case 'hang': {
      process.on('SIGTERM', () => undefined);
      setInterval(() => undefined, 1000);
      break;
    }
    case 'grandchild': {
      // A descendant that would outlive its parent. Its pid goes to a file so that the test can look for it.
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      writeFileSync(scenario.pidFile, String(child.pid));
      if (scenario.afterSpawn === 'exit') {
        process.stdout.write(JSON.stringify(cliResult()));
        process.exit(0);
      }
      setInterval(() => undefined, 1000);
      break;
    }
    case 'flood': {
      const block = 'x'.repeat(65536);
      const write = () => {
        while (process.stdout.write(block)) {
          // Write until the pipe is full, then wait for it to drain.
        }
        process.stdout.once('drain', write);
      };
      write();
      break;
    }
    case 'crash': {
      process.kill(process.pid, 'SIGABRT');
      break;
    }
    default:
      process.stderr.write('unknown scenario behaviour\n');
      process.exit(99);
  }
}
