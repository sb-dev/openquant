// The operating context printed with every result (OQ-04 sections 2 and 3): environment, session mode, money state,
// account, risk, observation time and time zone. S1 runs research only: every mission run is a BACKTEST on a simulated
// per-candidate ledger, no broker account exists, and nothing evaluates risk, so risk is UNKNOWN with its reason and
// never OK. These are facts of S1 (OQ-02 section 1, OQ-05 section 7), not values read from the API.

export type ApiEnvironment = 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
export type EnvironmentLabel = 'DEV' | 'STAGING' | 'PROD' | 'UNKNOWN';

export const ENVIRONMENT_LABELS: Readonly<Record<ApiEnvironment, EnvironmentLabel>> = {
  DEVELOPMENT: 'DEV',
  STAGING: 'STAGING',
  PRODUCTION: 'PROD',
};

export const RISK_REASON = 'no risk evaluation covers research candidates in S1';
export const ACCOUNT = 'simulated per-candidate ledger';

export interface DisplayContext {
  readonly environment: EnvironmentLabel;
  readonly api_environment: ApiEnvironment | null;
  readonly mode: 'BACKTEST';
  readonly money: 'SIMULATED';
  readonly account: typeof ACCOUNT;
  readonly risk: { readonly state: 'UNKNOWN'; readonly reason: string };
  /** When the client read the authoritative state shown, or null when it read none. */
  readonly observed_at: string | null;
  readonly time_zone: 'UTC';
}

export function displayContext(environment: ApiEnvironment | null, observedAt: string | null): DisplayContext {
  return {
    environment: environment === null ? 'UNKNOWN' : ENVIRONMENT_LABELS[environment],
    api_environment: environment,
    mode: 'BACKTEST',
    money: 'SIMULATED',
    account: ACCOUNT,
    risk: { state: 'UNKNOWN', reason: RISK_REASON },
    observed_at: observedAt,
    time_zone: 'UTC',
  };
}

/** The header lines, each at most 80 columns before wrapping. Every label is text; none depends on colour. */
export function headerLines(context: DisplayContext): string[] {
  return [
    `OpenQuant | env ${context.environment} | mode ${context.mode} | money ${context.money} | tz ${context.time_zone}`,
    `account: ${context.account} (no broker account)`,
    `risk: ${context.risk.state} - ${context.risk.reason}`,
    `read at: ${context.observed_at ?? 'nothing read from the API'}`,
  ];
}
