// The connected flow through the real HTTP application: a service principal claims an attempt, uploads its artefacts and
// submits its result, with a capability that the claim granted. The documents are synthetic, derived in the test from
// the records of the mission and written independently of the code under test (A04).
//
// What a helper checks is stated in the test that calls it. A helper never reads a rule out of src.

import { createHash } from 'node:crypto';
import { canonicalJson, digest, validateContract } from '@openquant/api-contracts';
import { issueCredential } from '../../src/auth/credentials.ts';
import type { WorkContext } from '../../src/domain/attempts.ts';
import { openAttempt } from '../../src/domain/attempts.ts';
import { allBuilders, startAssessment, startValidation } from '../../src/domain/builders.ts';
import type { Binding, BuildContext, Dispatch } from '../../src/domain/dispatch.ts';
import { storeBytes } from '../../src/domain/store.ts';
import { insertJob, type Work } from '../../src/domain/work.ts';
import { everyOperation } from './actors.ts';
import { bearer } from './app.ts';
import { ids } from './seed.ts';
import {
  createMission,
  createWorld,
  type Doc,
  fixture,
  recordRelease,
  registerRecords,
  startMission,
  type World,
  type WorldOptions,
} from './world.ts';

const encoder = new TextEncoder();

/** The executable of the batch host, as the release fixture lists it. */
export const ENGINE_BATCH = {
  name: 'engine-batch',
  version: '0.0.0',
  digest: 'sha256:ad92f935e18aa56a512ccd4042258902fc3e51279ff52b21d7a7b1d9bea18adc',
};
/** The runner, as the release fixture lists it. */
export const AGENT_RUNNER = {
  name: 'agent-runner',
  version: '0.0.0',
  digest: 'sha256:b0ffb22342c901c77a680bca58d98044774c9ab4895d3d557dced0ad24db4888',
};

export const sha = (label: string): string => `sha256:${createHash('sha256').update(label).digest('hex')}`;
export const digestOfBytes = (bytes: Uint8Array): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export const bytesOf = (doc: unknown): Uint8Array => encoder.encode(canonicalJson(doc));

export type PersonName = 'admin' | 'steward' | 'researcher' | 'viewer';
export type ServiceName = 'batch' | 'runner' | 'workflows' | 'deploy';

export interface Flow {
  readonly world: World;
  /** The release recorded for the environment. */
  release: Doc;
  /** A fresh access token of a person. */
  person(name: PersonName): Promise<string>;
  /** The long-lived credential of a service principal, scoped to every route. */
  service(name: ServiceName): string;
  send(
    method: string,
    path: string,
    token: string | undefined,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  /** The context of the guarded functions, with the builders of every kind of work that the API builds. */
  work(actorId?: string): WorkContext;
}

const principals: Record<PersonName, string> = {
  admin: ids.admin,
  steward: ids.steward,
  researcher: ids.researcher,
  viewer: ids.viewer,
};
const serviceIds: Record<ServiceName, string> = {
  batch: ids.batch,
  runner: ids.runner,
  workflows: ids.workflows,
  deploy: ids.deploy,
};

/** A world with credentials for its four people and four services, over the real HTTP application. */
export async function createFlow(options: WorldOptions = {}): Promise<Flow> {
  const world = await createWorld(options);
  const { testApp } = world;
  const now = testApp.clock.now();
  const people = {} as Record<PersonName, string>;
  const services = {} as Record<ServiceName, string>;
  await world.tx(async (tx) => {
    for (const [name, principalId] of Object.entries(principals) as [PersonName, string][]) {
      people[name] = (
        await issueCredential(tx, testApp.env.ids, now, { principalId, principalKind: 'HUMAN', issuedBy: ids.admin })
      ).token;
    }
    for (const [name, principalId] of Object.entries(serviceIds) as [ServiceName, string][]) {
      services[name] = (
        await issueCredential(tx, testApp.env.ids, now, {
          principalId,
          principalKind: 'SERVICE',
          operations: everyOperation,
          issuedBy: ids.admin,
        })
      ).token;
    }
  });
  const send: Flow['send'] = (method, path, token, body, headers = {}) => {
    const init: RequestInit = { method, headers: { ...(token === undefined ? {} : bearer(token)), ...headers } };
    if (body !== undefined) {
      init.body =
        body instanceof Uint8Array ? (body as BodyInit) : typeof body === 'string' ? body : JSON.stringify(body);
    }
    return testApp.request(path, init);
  };
  return {
    world,
    release: {},
    async person(name) {
      const response = await send('POST', '/v1/auth/token', people[name]);
      if (response.status !== 200) throw new Error(`auth.token answered ${response.status}`);
      return ((await response.json()) as { access_token: string }).access_token;
    },
    service: (name) => services[name],
    send,
    work: (actorId = ids.workflows) => ({
      env: testApp.env,
      actorId,
      builders: { ...allBuilders, agent: agentBuilder },
    }),
  };
}

export async function json<T = Doc>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

// --- the mission up to its first attempt ---------------------------------------------------------------------------

export interface Started {
  readonly missionId: string;
  readonly retrieve: { jobId: string; attemptId: string };
}

/** Records registered, the mission created and started, the release recorded: the retrieval attempt is PENDING. */
export async function startedFlow(
  options: WorldOptions & { readonly mission?: (mission: Doc) => void } = {},
): Promise<Flow & Started> {
  const flow = await createFlow(options);
  const { world } = flow;
  await registerRecords(world);
  const missionId = await createMission(world, options.mission);
  flow.release = await recordRelease(world);
  const retrieve = await startMission(world);
  return Object.assign(flow, { missionId, retrieve: { jobId: retrieve.jobId, attemptId: retrieve.attemptId } });
}

// --- claim, inputs, artefacts --------------------------------------------------------------------------------------

export interface Claimed {
  readonly attemptId: string;
  readonly ownershipRevision: number;
  readonly token: string;
  readonly leaseExpiresAt: string;
}

export async function outboxOf(
  flow: Flow,
  attemptId: string,
): Promise<{ digest: string; message: Doc; revision: number }> {
  const rows = await flow.world.sql<{ message_digest: string; message: Doc; ownership_revision: number }>(
    `SELECT o.message_digest, o.message, a.ownership_revision FROM outbox o JOIN attempts a ON a.attempt_id = o.attempt_id WHERE o.attempt_id = $1`,
    [attemptId],
  );
  const row = rows[0];
  if (row === undefined) throw new Error(`The attempt ${attemptId} has no outbox entry.`);
  return { digest: row.message_digest, message: row.message, revision: row.ownership_revision };
}

export function claimRequest(
  attemptId: string,
  revision: number,
  dispatchDigest: string,
  executable = ENGINE_BATCH,
): Doc {
  return {
    schema_version: 'attempt-claim/1',
    form: 'claim',
    attempt: { attempt_id: attemptId, ownership_revision: revision },
    dispatch_digest: dispatchDigest,
    executable: { ...executable },
    worker_id: 'worker-1',
  };
}

/** Claim an attempt as its host does, and return the capability that the grant carries. Throws when it is refused. */
export async function claim(
  flow: Flow,
  attemptId: string,
  who: ServiceName = 'batch',
  executable = ENGINE_BATCH,
): Promise<Claimed> {
  const outbox = await outboxOf(flow, attemptId);
  const response = await flow.send(
    'POST',
    `/v1/attempts/${attemptId}/claim`,
    flow.service(who),
    claimRequest(attemptId, outbox.revision, outbox.digest, executable),
  );
  if (response.status !== 200)
    throw new Error(`The claim of ${attemptId} answered ${response.status}: ${await response.text()}`);
  const grant = await json<{ capability: { token: string }; lease_expires_at: string }>(response);
  return {
    attemptId,
    ownershipRevision: outbox.revision,
    token: grant.capability.token,
    leaseExpiresAt: grant.lease_expires_at,
  };
}

export async function upload(
  flow: Flow,
  claimed: Pick<Claimed, 'attemptId' | 'token'>,
  bytes: Uint8Array,
  mediaType = 'application/json',
): Promise<{ digest: string; media_type: string; size_bytes: number }> {
  const hash = digestOfBytes(bytes);
  const response = await flow.send('PUT', `/v1/attempts/${claimed.attemptId}/artefacts/${hash}`, claimed.token, bytes, {
    'content-type': mediaType,
  });
  if (response.status !== 204) throw new Error(`The upload answered ${response.status}: ${await response.text()}`);
  return { digest: hash, media_type: mediaType, size_bytes: bytes.length };
}

export const uploadDoc = (flow: Flow, claimed: Pick<Claimed, 'attemptId' | 'token'>, doc: unknown) =>
  upload(flow, claimed, bytesOf(doc));

export async function submit(
  flow: Flow,
  claimed: Pick<Claimed, 'attemptId' | 'token'>,
  route: string,
  doc: unknown,
): Promise<Response> {
  return flow.send('POST', `/v1/attempts/${claimed.attemptId}/${route}`, claimed.token, JSON.stringify(doc));
}

export async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { code: string }).code;
}

// --- the synthetic dataset -----------------------------------------------------------------------------------------

const DAY = 24 * 3600 * 1000;

/** Every weekday from `first` to `last` inclusive (no holidays): the calendar of the synthetic manifest. */
export function weekdays(first: string, last: string): string[] {
  const out: string[] = [];
  for (let at = Date.parse(`${first}T00:00:00Z`); at <= Date.parse(`${last}T00:00:00Z`); at += DAY) {
    const day = new Date(at).getUTCDay();
    if (day !== 0 && day !== 6) out.push(new Date(at).toISOString().slice(0, 10));
  }
  return out;
}

export interface ManifestOptions {
  readonly jobId: string;
  readonly attemptId: string;
  readonly requestDigest: string;
  readonly revision?: number;
  /** Sessions without a bar (a PARTIAL snapshot). */
  readonly missing?: readonly string[];
  readonly completeness?: 'COMPLETE' | 'PARTIAL' | 'NO_OBSERVATIONS';
  readonly edit?: (manifest: Doc) => void;
  readonly executable?: typeof ENGINE_BATCH;
}

export const closeAt = (session: string): string => `${session}T21:00:00Z`;
export const availableAt = (session: string): string => `${session}T23:00:00Z`;

/** A synthetic dataset manifest for the mission of the pilot profile: weekdays 2022-01-03 to 2025-12-31, no holidays. */
export function manifestFor(flow: Flow & Started, options: ManifestOptions): Doc {
  const { world } = flow;
  const profile = world.docs.profile;
  const instrument = (fixture('command.create-mission.json').payload as Doc).mission.instrument as Doc;
  const sessions = weekdays('2022-01-03', '2025-12-31');
  const missing = new Set(options.missing ?? []);
  const none = options.completeness === 'NO_OBSERVATIONS';
  const bars = none
    ? []
    : sessions
        .filter((session) => !missing.has(session))
        .map((session, index) => ({
          session,
          open: `${100 + (index % 7)}.00`,
          high: `${102 + (index % 7)}.00`,
          low: `${98 + (index % 7)}.00`,
          close: `${101 + (index % 7)}.00`,
          volume: '1000000',
          event_time: closeAt(session),
          available_at: availableAt(session),
        }));
  const manifest: Doc = {
    schema_version: 'dataset-manifest/1',
    dataset: {
      id: 'ds-aapl-synthetic',
      version: '1',
      source: 'PROVIDER',
      licence: 'Synthetic test data, no provider terms.',
    },
    instrument,
    source: {
      provider: 'alpaca',
      feed: 'SIP',
      adapter: { name: 'alpaca-adapter', version: '1' },
      transformation: { name: 'daily-normaliser', version: '1', digest: sha('daily-normaliser rules') },
      executable: { ...(options.executable ?? ENGINE_BATCH) },
      profile: { id: profile.profile_id, revision: profile.revision, digest: world.records.profile.digest },
    },
    semantics: profile.data,
    coverage: {
      requested: profile.history,
      ...(none ? {} : { returned: { start: sessions[0], end: sessions.at(-1) } }),
      completeness: options.completeness ?? (missing.size > 0 ? 'PARTIAL' : 'COMPLETE'),
      bar_count: bars.length,
      missing_sessions: [...missing],
    },
    retrieval: {
      job_id: options.jobId,
      attempt_id: options.attemptId,
      request_digest: options.requestDigest,
      retrieved_at: '2026-11-15T10:00:30Z',
    },
    content: {
      calendar: sessions.map((session) => ({ session, open_at: `${session}T14:30:00Z`, close_at: closeAt(session) })),
      bars,
      corporate_actions: [],
      unplanned_events: [],
      action_evidence: [],
    },
    source_responses: [],
    constraints: { redistribution: 'NOT_PERMITTED', raw_retention: 'DO_NOT_RETAIN', terms_ref: 'synthetic' },
  };
  options.edit?.(manifest);
  return manifest;
}

export function retrievalResult(
  claimed: Pick<Claimed, 'attemptId' | 'ownershipRevision'>,
  jobId: string,
  requestDigest: string,
  outcome: Doc,
  edit?: (result: Doc) => void,
): Doc {
  const result: Doc = {
    schema_version: 'retrieval-result/1',
    job_id: jobId,
    attempt: { attempt_id: claimed.attemptId, ownership_revision: claimed.ownershipRevision },
    request_digest: requestDigest,
    executable: { ...ENGINE_BATCH },
    outcome,
    calls: [
      {
        sequence: 1,
        operation: 'provider:alpaca/calendar@1',
        started_at: '2026-11-15T10:00:01Z',
        result: 'SUCCEEDED',
        http_status: 200,
      },
      {
        sequence: 2,
        operation: 'provider:alpaca/daily_bars@1',
        started_at: '2026-11-15T10:00:02Z',
        result: 'SUCCEEDED',
        http_status: 200,
      },
    ],
    usage: {
      provider_requests: { label: 'observed', count: 2 },
      provider_credits: { label: 'unknown', reason: 'The provider reports no credit usage.' },
      duration: { label: 'observed', milliseconds: 4120 },
    },
    started_at: '2026-11-15T10:00:00Z',
    finished_at: '2026-11-15T10:00:05Z',
  };
  edit?.(result);
  return result;
}

/** The retrieval request that the API stored for an attempt, by the digest that its dispatch names. */
export async function requestOf(flow: Flow, attemptId: string): Promise<{ digest: string; document: Doc }> {
  const { message } = await outboxOf(flow, attemptId);
  const ref = (message.inputs as Doc).request as { digest: string };
  const bytes = await flow.world.testApp.objects.get(ref.digest as never);
  return { digest: ref.digest, document: JSON.parse(new TextDecoder().decode(bytes as Uint8Array)) as Doc };
}

/**
 * The whole retrieval, as the batch host does it: claim, read the request, upload the manifest, submit the result.
 * Returns the response of the submission. The mission has its evaluation plan when it was accepted.
 */
export async function driveRetrieval(
  flow: Flow & Started,
  options: { manifest?: Partial<ManifestOptions>; resultEdit?: (result: Doc) => void } = {},
): Promise<{
  claimed: Claimed;
  response: Response;
  manifestRef: { digest: string; media_type: string; size_bytes: number };
}> {
  const { jobId, attemptId } = flow.retrieve;
  const claimed = await claim(flow, attemptId);
  const request = await requestOf(flow, attemptId);
  const manifest = manifestFor(flow, { jobId, attemptId, requestDigest: request.digest, ...options.manifest });
  const checked = validateContract('dataset-manifest', manifest);
  if (!checked.ok) throw new Error(`The synthetic manifest is not valid: ${checked.error.message}`);
  const manifestRef = await upload(flow, claimed, bytesOf(manifest));
  const status = manifest.coverage.completeness as string;
  const result = retrievalResult(claimed, jobId, request.digest, { status, manifest: manifestRef }, options.resultEdit);
  const response = await submit(flow, claimed, 'retrieval-result', result);
  return { claimed, response, manifestRef };
}

export { digest };

// --- agent work: the first attempt is built by the workflow that assembles the role request ------------------------------

/** The first dispatch of an agent attempt, as a workflow builds it: a request document and an agent-dispatch/1. */
async function agentBuilder({ tx, env, actorId }: BuildContext, work: Work, binding: Binding): Promise<Dispatch> {
  const role = work.agentRole === 'CRITIC' ? 'critic' : 'proposer';
  const request = await storeBytes(tx, env, bytesOf({ test_request_for: work.id, role }), actorId);
  const base = fixture('agent-dispatch.proposer.json');
  const message: Doc = {
    ...base,
    environment: env.environment,
    identity: {
      mission_id: work.missionId,
      run_id: work.id,
      attempt: { attempt_id: binding.attemptId, ownership_revision: binding.ownershipRevision },
      session_id: env.ids.next('sess'),
      role,
      skill: { id: role === 'critic' ? 'strategy-critique' : 'strategy-formulation', version: '1' },
      bundle_hash: base.identity.bundle_hash,
    },
    inputs: {
      request: {
        contract: `${role === 'critic' ? 'strategy-critique' : 'strategy-formulation'}.request/1`,
        artefact: request,
      },
      holdout_exclusions: base.inputs.holdout_exclusions,
    },
    result_route: `/v1/attempts/${binding.attemptId}/agent-result`,
  };
  const checked = validateContract('agent-dispatch', message);
  if (!checked.ok) throw new Error(`The test agent dispatch is not valid: ${checked.error.message}`);
  return { destination: 'AGENT_RUNNER', message };
}

export interface StartedWork {
  readonly jobId: string;
  readonly attemptId: string;
}

/** A logical run of an agent for a trial slot, with its first attempt, reservation and outbox entry. */
export async function startAgent(
  flow: Flow & Started,
  options: { slot?: string; role?: 'PROPOSER' | 'CRITIC'; configuration?: string } = {},
): Promise<StartedWork> {
  const role = options.role ?? 'CRITIC';
  return flow.world.tx(async (tx) => {
    const job = await insertJob(tx, flow.world.testApp.env, {
      missionId: flow.missionId,
      kind: 'agent',
      attemptCap: 3,
      configurationId: options.configuration ?? (role === 'CRITIC' ? 'critic' : 'proposer-a'),
      agentRole: role,
      ...(options.slot === undefined ? {} : { trialSlot: options.slot }),
    });
    const opened = await openAttempt(tx, flow.work(), job);
    if (!opened.ok) throw new Error(`The agent attempt was not reserved: ${opened.reason}`);
    return { jobId: job.id, attemptId: opened.attemptId };
  });
}

export async function startValidationOf(
  flow: Flow & Started,
  input: { trialSlot: string; draftDigest: string; parentHash?: string },
): Promise<StartedWork> {
  const started = await flow.world.tx((tx) =>
    startValidation(tx, flow.work(), { missionId: flow.missionId, ...input }),
  );
  if (!started.ok) throw new Error(`The validation did not start: ${started.reason}`);
  return { jobId: started.jobId, attemptId: started.attemptId };
}

export async function startAssessmentOf(flow: Flow & Started, trialSlot: string): Promise<StartedWork> {
  const started = await flow.world.tx((tx) =>
    startAssessment(tx, flow.work(), { missionId: flow.missionId, trialSlot }),
  );
  if (!started.ok) throw new Error(`The assessment did not start: ${started.reason}`);
  return { jobId: started.jobId, attemptId: started.attemptId };
}

/** The cancel_mission payload of the fixture, for one mission. */
export function cancelMissionPayload(missionId: string): Doc {
  return { ...(fixture('command.cancel-mission.json').payload as Doc), mission_id: missionId };
}
