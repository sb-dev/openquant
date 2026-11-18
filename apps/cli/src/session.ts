// The client of a logged-in person (OQ-05 section 9): the stored long-lived credential is exchanged for a 15-minute
// access token, which is renewed a minute before it expires and once after UNAUTHENTICATED. The renewed token is
// written back to the credentials file. Renewal never throws: a failed renewal leaves the expired token, which the API
// refuses with UNAUTHENTICATED, so no command is ever sent without an answer it can be read back by.

import { ApiClient, type Fetch } from '@openquant/api-client';
import type { Store, StoredSession } from './store.ts';

export interface ClientSettings {
  readonly fetch: Fetch | undefined;
  readonly timeoutMs: number;
  readonly readBack: { readonly attempts: number; readonly delayMs: number } | undefined;
  readonly sleep: ((ms: number) => Promise<void>) | undefined;
  readonly now: () => Date;
}

/** A client with no credentials, for the token route. */
export function bareClient(baseUrl: string, settings: ClientSettings): ApiClient {
  return new ApiClient({
    baseUrl,
    timeoutMs: settings.timeoutMs,
    now: settings.now,
    ...(settings.fetch === undefined ? {} : { fetch: settings.fetch }),
  });
}

const RENEW_BEFORE_MS = 60_000;

export function sessionClient(store: Store, session: StoredSession, settings: ClientSettings): ApiClient {
  let current = session;
  const exchange = bareClient(session.api_url, settings);
  const refresh = async (): Promise<string | undefined> => {
    try {
      const token = await exchange.exchangeCredential(current.credential);
      current = {
        ...current,
        access_token: token.access_token,
        access_token_expires_at: token.expires_at,
        roles: token.roles,
      };
      store.writeSession(current);
      return token.access_token;
    } catch {
      // A refused credential (UNAUTHENTICATED) or no answer: the request goes out with the token it has.
      return undefined;
    }
  };
  return new ApiClient({
    baseUrl: session.api_url,
    timeoutMs: settings.timeoutMs,
    now: settings.now,
    ...(settings.fetch === undefined ? {} : { fetch: settings.fetch }),
    ...(settings.readBack === undefined ? {} : { readBack: settings.readBack }),
    ...(settings.sleep === undefined ? {} : { sleep: settings.sleep }),
    auth: {
      accessToken: async () => {
        const expires = Date.parse(current.access_token_expires_at);
        if (Number.isFinite(expires) && expires - settings.now().getTime() > RENEW_BEFORE_MS)
          return current.access_token;
        return (await refresh()) ?? current.access_token;
      },
      refresh,
    },
  });
}
