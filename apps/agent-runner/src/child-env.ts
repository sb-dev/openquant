// The environment of the delegated executor (OQ-03 sections 3 and 4, OQ-05 sections 5 and 9).
//
// The child never inherits the environment of the runner. It receives a fixed set of neutral variables, the fresh
// HOME, TMPDIR and PATH of its attempt, and the names that the configuration allows, each copied from the runner's
// environment. The host's own service credentials are never allowed: the configuration refuses their names, and the
// builder never reads any other name. Proxy and certificate variables pass only behind an explicit flag that tests
// and local development set, never in production.

/** Variables that route traffic or choose certificates. They pass only when `allowProxyEnv` is set. */
export const PROXY_AND_CA_VARIABLES: readonly string[] = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
];

// Name prefixes of credentials that belong to the host or to other systems. A configuration that lists one of
// them as a variable for the child is refused, whatever the reason.
const FORBIDDEN_PREFIXES: readonly string[] = [
  'AGENT_RUNNER_',
  'CLOUDFLARE_',
  'CF_',
  'FLY_',
  'ALPACA_',
  'APCA_',
  'AWS_',
  'R2_',
  'DATABASE_',
  'PG',
  'POSTGRES',
  'NEON_',
  'HYPERDRIVE_',
  'GITHUB_',
  'GH_',
  'NPM_',
  'PACTWRIGHT_',
  'OPENQUANT_',
];

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Why a variable name cannot be passed to the child, or undefined when it can. */
export function passEnvProblem(name: string): string | undefined {
  if (!NAME_PATTERN.test(name)) return `${name} is not an upper-case variable name`;
  if (PROXY_AND_CA_VARIABLES.includes(name)) return `${name} is a proxy or certificate variable; use allowProxyEnv`;
  const prefix = FORBIDDEN_PREFIXES.find((candidate) => name.startsWith(candidate));
  if (prefix) return `${name} starts with ${prefix}, which names a credential of the host or of another system`;
  if (name === 'HOME' || name === 'PATH' || name === 'TMPDIR') return `${name} is set by the runner`;
  return undefined;
}

export interface ChildEnvironmentSpec {
  /** The environment of the runner. Only the allowed names are read from it. */
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
  /** The names that are copied from the host environment, such as the model credential. */
  readonly passEnv: readonly string[];
  readonly allowProxyEnv: boolean;
  readonly home: string;
  readonly tmp: string;
  readonly path: string;
  /** Fixed variables of the executor itself (configuration directory, switches that turn traffic off). */
  readonly fixed: Readonly<Record<string, string>>;
}

export function buildChildEnvironment(spec: ChildEnvironmentSpec): Record<string, string> {
  const env: Record<string, string> = {
    PATH: spec.path,
    HOME: spec.home,
    TMPDIR: spec.tmp,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NO_COLOR: '1',
    ...spec.fixed,
  };
  const names = [...spec.passEnv, ...(spec.allowProxyEnv ? PROXY_AND_CA_VARIABLES : [])];
  for (const name of names) {
    const value = spec.hostEnv[name];
    if (typeof value === 'string' && value.length > 0 && !(name in env)) env[name] = value;
  }
  return env;
}
