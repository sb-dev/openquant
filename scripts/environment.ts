// The environment of every process that verification starts: the repository checks and their tests, each Cargo
// and pnpm step, and the version checks (OQ-06 sections 1 and 7). It is the caller's environment without the
// variables that change which tests run, how code is compiled or linked, which runner starts a test binary, which
// file a shell reads first, or how Turborepo runs. An inherited variable therefore cannot switch a step off.
// Proxy, certificate and toolchain variables (PATH, HTTPS_PROXY, NODE_EXTRA_CA_CERTS, RUSTUP_TOOLCHAIN,
// CARGO_HOME, CARGO_TARGET_DIR) are kept. scripts/s0.ts holds a literal copy of this code and compares the two.
const removedNames: ReadonlySet<string> = new Set([
  'BASH_ENV',
  'ENV',
  'NODE_OPTIONS',
  'RUSTFLAGS',
  'RUSTDOCFLAGS',
  'RUSTC_WRAPPER',
  'RUSTC_WORKSPACE_WRAPPER',
  'CARGO_BUILD_RUSTFLAGS',
  'CARGO_BUILD_RUSTDOCFLAGS',
  'CARGO_ENCODED_RUSTFLAGS',
  'CARGO_ENCODED_RUSTDOCFLAGS',
  'CARGO_BUILD_RUSTC_WRAPPER',
  'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER',
  'BIOME_CONFIG_PATH',
]);
const removedPatterns: readonly RegExp[] = [/^NODE_TEST_/, /^TURBO_/, /^CARGO_TARGET_.+_(?:RUNNER|RUSTFLAGS|RUSTDOCFLAGS|LINKER)$/];

export function isRemovedVariable(name: string): boolean {
  const key = name.toUpperCase();
  return removedNames.has(key) || removedPatterns.some((pattern) => pattern.test(key));
}

export function stepEnvironment(): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (isRemovedVariable(name)) delete environment[name];
  }
  // No Turborepo telemetry. pnpm 11 installs before `exec` when it finds the install out of date; here it must
  // fail instead, so a step can never install silently.
  environment.TURBO_TELEMETRY_DISABLED = '1';
  environment.pnpm_config_verify_deps_before_run = 'error';
  return environment;
}
