// The handler registry: route id to implementation. A route of the manifest is served by exactly one of this table
// and the deferred table (deferred.ts).

import { authToken } from './auth-token.ts';
import type { Handler } from './context.ts';
import { systemIdentity } from './system-identity.ts';

export const handlers: Readonly<Record<string, Handler>> = {
  'auth.token': authToken,
  'system.identity': systemIdentity,
};
