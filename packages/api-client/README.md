# Typed client transport

Status: S1 HTTP client implemented (`@openquant/api-client`); operational events and reconnection arrive with the notification channel, which S1 does not have. See [architecture](../../docs/specs/05-system-architecture-and-data-spec.md) §§2, 7 to 9.

`ApiClient` calls the routes of [routes/v1.json](../api-contracts/routes/v1.json) that a person uses. It checks at load that each route it names exists with the method, request and response it expects, and:

- validates every answer with the shared validators of `@openquant/api-contracts` (the access-token view, which is no contract, field by field) and refuses one that fails (`ResponseContractError`);
- gives every command a client command ID, checks the request against `command/1` before sending it, and reads a `PENDING` command back within a bound;
- treats a missing answer, an unusable one or one whose state change is `UNKNOWN` as unknown until a read-back by command ID settles it, and reports `UNKNOWN` otherwise; `resolveCommand` reads back and, only when the API has no command with that ID, sends the identical request once;
- resynchronises a `REVISION_CONFLICT` from the authoritative mission and never retries it with a newer revision;
- maps each `api-error/1` code to a typed error (`UnauthenticatedError`, `ForbiddenError`, `NotFoundError`, `RevisionConflictError`, `CommandIdReusedError`, `InvalidRequestError`, `RefusedError`, `UnavailableError`, `InternalApiError`);
- renews an access token once after `UNAUTHENTICATED` through its `AuthProvider`;
- reads the official `evaluation-metrics/1` and `evaluation-result/1` of a run unchanged (`runMetrics`, `runResult`; `NotFoundError` while none is committed) and the mission's evaluation plan (`plan`).

It runs in Workers, Node and browsers: its build bundles `src/` for the neutral platform and fails on a Node import, and the workspace import boundaries forbid Node built-ins and any import of `apps/api` here.
