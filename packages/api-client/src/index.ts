// @openquant/api-client: the typed client of the S1 API routes (OQ-05 sections 2 and 8). It runs in Workers, Node and
// browsers: it imports no Node module.

export {
  type AccessToken,
  ApiClient,
  type AuthProvider,
  type ClientOptions,
  type CommandOptions,
  type CommandOutcome,
  InvalidCommandError,
  parseAccessToken,
  utcTimestamp,
} from './client.ts';
export {
  ApiError,
  type ApiErrorBody,
  apiErrorOf,
  ClientError,
  CommandIdReusedError,
  ForbiddenError,
  InternalApiError,
  InvalidRequestError,
  NotFoundError,
  RefusedError,
  ResponseContractError,
  type Resync,
  RevisionConflictError,
  TransportError,
  UnauthenticatedError,
  UnavailableError,
} from './errors.ts';
export type { Fetch, FetchInit, FetchResponse } from './platform.ts';
export {
  CLIENT_ROUTES,
  type CommandRouteId,
  pathOf,
  type RouteId,
  route,
  statusOfCode,
  type ViewOf,
  type ViewRouteId,
} from './routes.ts';
