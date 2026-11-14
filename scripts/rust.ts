import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

// The Rust steps of `pnpm verify`. Each is real work; none prints success on its own.
// scripts/s0.ts compares this list, step by step and in order, with a literal copy of the expected steps.
// The contracts report is the Rust side of the TypeScript parity test that the TypeScript steps run.
export const cargoCommands = [
  'cargo fmt --all --check',
  'cargo clippy --workspace --all-targets --locked -- -D warnings',
  'cargo test --workspace --locked',
  'cargo run --locked -p openquant-engine --bin s0-replay -- --out local-runs/s0',
  'cargo run --locked -p openquant-contracts --bin contracts-report -- --out local-runs/contracts',
] as const;

export function toolchainChannel(base: string): string {
  const text = readFileSync(resolve(base, 'rust-toolchain.toml'), 'utf8');
  const match = /^channel\s*=\s*"([^"]+)"/m.exec(text);
  if (!match) throw new Error('rust-toolchain.toml has no channel');
  return match[1];
}

// The pinned toolchain must be the one that runs. rustup does not install it on its own.
export function toolchainPinError(base: string): string | undefined {
  const channel = toolchainChannel(base);
  const result = spawnSync('rustc', ['--version'], { cwd: base, encoding: 'utf8' });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return `rustc was not found on PATH. S0 verification needs the pinned Rust toolchain ${channel}. Install rustup (https://rustup.rs), then run: rustup toolchain install`;
  }
  if (result.error || result.status !== 0) {
    return `Cannot run the pinned Rust toolchain ${channel}. Run: rustup toolchain install\n${result.stderr ?? result.error?.message ?? ''}`;
  }
  if (!result.stdout.startsWith(`rustc ${channel} `)) {
    return `Expected rustc ${channel} from rust-toolchain.toml, found: ${result.stdout.trim()}`;
  }
  return undefined;
}

// Digest of every file under fixtures/. Golden data must not change while verification runs.
export function fixtureDigest(base: string): string {
  const hash = createHash('sha256');
  const walk = (directory: string) => {
    const entries = readdirSync(resolve(base, directory), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) hash.update(path).update('\0').update(readFileSync(resolve(base, path))).update('\0');
    }
  };
  walk('fixtures');
  return hash.digest('hex');
}

export function runCargo(base: string, command: string): number {
  const [program, ...args] = command.split(' ');
  console.log(`\n$ ${command}`);
  const result = spawnSync(program, args, { cwd: base, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  return result.status ?? 1;
}
