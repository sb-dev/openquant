// What an authenticated caller may do on one route (OQ-05 section 9). The route manifest lists the credentials that a
// route accepts, and any one of them is enough. Roles are applied as listed, with no hierarchy: Administrator does not
// imply Steward. A valid credential of a kind that the route does not accept, a role or principal that it does not
// list, a service credential without the route among its operations, and a capability for another attempt than the
// path names are FORBIDDEN. A capability whose attempt has lost its lease gets the typed 409 of OQ-05 section 4.

import { ApiFailure } from '../errors.ts';
import type { AuthRule, RouteSpec } from '../manifest.ts';
import type { Caller } from './authenticate.ts';

function accepts(rule: AuthRule, route: RouteSpec, caller: Caller, params: Readonly<Record<string, string>>): boolean {
  switch (rule.kind) {
    case 'human_credential':
      return caller.kind === 'human_credential';
    case 'human':
      return caller.kind === 'human' && caller.roles.some((role) => rule.roles.includes(role));
    case 'service':
      return (
        caller.kind === 'service' &&
        caller.principal.serviceKind !== null &&
        rule.principals.includes(caller.principal.serviceKind) &&
        caller.operations.includes(route.id)
      );
    case 'attempt':
      return (
        caller.kind === 'attempt' &&
        caller.principal.serviceKind !== null &&
        rule.principals.includes(caller.principal.serviceKind) &&
        params.attempt_id === caller.attempt.attemptId
      );
  }
}

/** The failure to answer with, or undefined when the caller may call the route. */
export function authorize(
  route: RouteSpec,
  caller: Caller,
  params: Readonly<Record<string, string>>,
): ApiFailure | undefined {
  if (!route.auth.some((rule) => accepts(rule, route, caller, params))) {
    return new ApiFailure('FORBIDDEN', 'This credential may not call this route.');
  }
  if (caller.kind === 'attempt') {
    // Both outcomes are in the error list of every attempt route. No state changes: only the rejection is recorded.
    if (caller.attempt.state === 'stale') {
      return new ApiFailure(
        'STALE_OWNERSHIP',
        'A newer attempt of the same run or job exists: this attempt no longer owns it.',
      );
    }
    if (caller.attempt.state === 'lease_expired') {
      return new ApiFailure('LEASE_EXPIRED', 'The lease of this attempt has ended.');
    }
  }
  return undefined;
}
