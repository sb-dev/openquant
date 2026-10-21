# AICaaS Platform — Tech Stack Specification

## Summary

| Layer | Technology | Role |
|-------|-----------|------|
| **Frontend** | React Router v7 | SSR, direct CRUD via Hyperdrive, multiple app variations (dashboard, admin, etc.) |
| **Orchestration** | Hono | API for triggering Workflows, streaming LLM calls, webhooks, CLI, agent-to-agent communication |
| **Agent execution** | Cloudflare Workflows | Durable multi-step agent chains with automatic retry, status updates via Durable Objects |
| **Real-time** | Durable Objects | WebSocket hub for live progress updates, session state (SQLite), actor model for agents |
| **Database** | Neon Postgres + Hyperdrive | Full Postgres (pgvector, JSONB), connection pooled via Hyperdrive, query caching for cacheable queries |
| **File storage** | R2 | S3-compatible object storage, no egress fees |
| **Knowledge layer** | SurrealDB (add when building Memory) | Multi-model DB: graph + vector + document + permissions in one query. Agent memory, knowledge graphs, GraphRAG |
| **Monorepo** | pnpm + Turborepo | Shared packages (types, UI kit, WebSocket client, typed API client), cached builds |
| **Observability** | Better Stack + CF Observability | Logs, uptime, alerting, on-call, status page, cost monitoring, APIs for custom dashboards, distributed tracing |
| **IaC** | Terraform | Cloudflare provider for Hyperdrive, R2, DNS, routing |
| **Frontend mocking** | MSW + Storybook + mock clients | HTTP interception, WebSocket simulation, SSE streaming — zero backend cost during UI development |

**Launch stack:** Two Workers (frontend + API), one Durable Object class, Workflows, Hyperdrive, R2, Neon, Better Stack. Estimated cost: ~$35-39/month dev, ~$55-65/month production (warm database).

**Documented extensions (add when needed):** Rate limiting (Durable Object per provider), KV (fine-grained caching), AI Gateway (LLM proxy), SurrealDB (knowledge/memory layer), Cloudflare Queues (Fly.io bridge, webhooks, fan-out, event bus), Fly.io Rust workers (CPU-heavy tasks).

## Table of Contents

1. [Overview](#1-overview)
2. [Decision Log](#2-decision-log) — Cloudflare, React Router v7, Hono, Workflows+DO, Terraform, TypeScript
3. [Architecture](#3-architecture) — System diagram
4. [Components](#4-components)
   - 4.1 React Router v7 — UI Layer
   - 4.2 Hono — Orchestration Layer
   - 4.3 Durable Objects — Stateful Edge Compute
   - 4.4 Rate Limiting (Add When Needed)
   - 4.5 Streaming — Text and Audio
   - 4.6 Cloudflare Workflows — Durable Multi-Step Orchestration
   - 4.7 Storage
   - 4.8 AI Gateway (Early Extension)
   - 4.9 Knowledge Layer — SurrealDB (Add When Building Memory)
5. [Infrastructure as Code](#5-infrastructure-as-code) — Monorepo, project layout, Terraform, Wrangler configs
6. [Deployment](#6-deployment) — Local dev, production
7. [Observability, Metrics, and Alerts](#7-observability-metrics-and-alerts) — Better Stack, CF tracing, cost monitoring, API integration for custom dashboards
8. [Fly.io Extension Path](#8-flyio-extension-path) — When to migrate, Queue bridge, Terraform
9. [Glossary](#9-glossary)
10. [Cost Estimate](#10-cost-estimate-starting-point)
11. [When to Introduce Queues](#11-when-to-introduce-cloudflare-queues) — Fly.io, webhooks, fan-out, event bus
12. [Known Constraints and Mitigations](#12-known-constraints-and-mitigations) — DO bottlenecks, Workflow payload limits, auth duplication, Neon cold starts
13. [Frontend Mocking Strategy](#13-frontend-mocking-strategy) — MSW, Storybook, WebSocket mocks, SSE streams, monorepo layout

---

## 1. Overview

This document specifies the technology stack for the AICaaS (AI-as-a-Service) platform. The platform enables autonomous organizational frameworks where AI agents collaborate like a company, structured in three layers: Brain (decision-making), Heart (stateless execution), and Memory (persistent knowledge).

The stack is Cloudflare-first, organized as a pnpm + Turborepo monorepo. Multiple frontend Workers (React Router v7 for dashboard, admin, onboarding, etc.) share types, components, and a typed API client. One API Worker (Hono) handles all orchestration, with Workflows for durable agent chains and a Durable Object for real-time WebSocket updates. No message queues at launch. Extensions (rate limiting, KV caching, Queues, Fly.io) are documented as add-when-needed patterns.

---

## 2. Decision Log

Each technology choice was evaluated against three criteria: cost-efficiency, operational simplicity, and Cloudflare-native integration.

### Why Cloudflare over AWS/GCP/Vercel?

Cloudflare bills Workers based on **CPU time**, not wall time. Agent orchestration is 95%+ I/O wait (waiting on LLM API responses). A typical agent chain uses 15-30ms of CPU across 30 seconds of wall time. On AWS Lambda or GCP Cloud Run, you'd pay for all 30 seconds. On Cloudflare, you pay for 30ms. For LLM orchestration workloads, this is an order-of-magnitude cost difference.

The $5/month Workers Paid plan covers a surprisingly large amount of agent traffic.

### Why React Router v7 over Next.js?

Next.js was not designed for Cloudflare. Deploying it requires the OpenNext adapter, which reverse-engineers Next.js build output and transforms it for Workers. This creates friction: ISR works differently, some Node.js APIs are unavailable, `next dev` runs in Node.js (not the Workers runtime), so Cloudflare-specific APIs like Durable Objects and KV can't be tested locally without workarounds.

React Router v7 (the evolution of Remix) has a first-class Cloudflare integration via the Cloudflare Vite plugin. The dev server runs in `workerd` (Cloudflare's runtime), so local development matches production exactly. It's GA on Cloudflare, not beta. You keep the full React ecosystem.

The tradeoff: React Server Components (RSC) support in React Router v7 is still experimental. If RSC becomes critical, this decision should be revisited. Additionally, SPA mode and prerendering are not currently supported with the Cloudflare Vite plugin — all frontend apps use SSR. This is the intended mode for this architecture (SSR enables server-side loaders that query Postgres directly and actions that call Hono via Service Binding). If a future product variant needs a pure client-side bundle (e.g., an embeddable widget for customer sites), build it as a standalone React library via Vite's library mode, served from R2 — no Workers or Cloudflare Vite plugin involved.

### Why Hono for the orchestration layer?

Hono is one of the fastest routers on Cloudflare Workers. Its total bundle size with the `hono/tiny` preset is under 14KB with zero dependencies. It's Express-like in API design but purpose-built for edge runtimes. First-class TypeScript support with typed bindings for Cloudflare resources.

Hono is **not** the CRUD layer. React Router v7's loaders and actions handle direct reads and writes to Postgres — they're closer to the UI, with fewer hops. Hono handles **orchestration**: triggering Workflows, managing Durable Object sessions, proxying streaming LLM calls, rate limiting, webhooks, and serving non-browser clients (CLI, agent-to-agent communication).

The rule: if a request can be satisfied with a single SQL query, it stays in React Router. If it involves coordination across multiple services (Workflows, Durable Objects, external APIs), it routes to Hono. This keeps Hono focused and avoids an extra network hop for simple reads.

### Why Workflows + Durable Objects over Queues?

The starting architecture has no message queues. Instead:

- **Workflows** handle durable multi-step agent orchestration. Hono triggers a Workflow directly (`env.WORKFLOW.create()`). Each step persists automatically, retries on failure, and costs nothing while waiting on I/O. This gives you guaranteed delivery and durability without a separate messaging layer.
- **Durable Objects** handle real-time updates. Workflow steps push status updates directly to a Durable Object, which broadcasts via WebSocket to connected browsers.

Queues (Cloudflare Queues, NATS, Kafka) are not needed at launch. They add operational complexity for problems that Workflows and Durable Objects solve natively. See Section 11 for when Queues become necessary.

Workers run in V8 isolates with no persistent TCP connections. This rules out NATS and Kafka entirely (they require long-lived TCP). If and when Queues are needed, Cloudflare Queues is the choice — it's a native binding, and supports HTTP pull-based consumers for the Fly.io extension path.

### Why Terraform for IaC?

Cloudflare uses Terraform internally to manage their own production accounts. The Cloudflare Terraform Provider is auto-generated from their OpenAPI spec, so it stays in sync with API changes. It's the most mature and battle-tested IaC option for Cloudflare.

Pulumi (which lets you write IaC in TypeScript instead of HCL) was considered. It has a good Cloudflare provider and avoids learning a new language. However, Terraform has deeper community support, more examples, and Cloudflare's own dogfooding provides confidence. For a team unfamiliar with either, the maturity gap matters more than the language preference.

The Terraform Cloudflare provider also covers Fly.io resources when the extension path is needed, keeping all infrastructure in one tool.

### Why TypeScript over Rust for orchestration?

Rust is faster per CPU cycle. But on Cloudflare Workers, agent orchestration uses ~30ms of CPU per request (JSON parsing, prompt assembly, response handling). The rest is I/O wait, which costs nothing. Rust reducing that 30ms to 3ms saves fractions of a cent per million requests.

The cost savings from Rust's performance are negligible when I/O dominates. TypeScript gives faster development velocity, access to the entire npm ecosystem, and native integration with all Cloudflare services. Rust is reserved for the Fly.io extension path, where sustained CPU work (document processing, batch analysis, local inference) justifies it.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLOUDFLARE EDGE                          │
│                                                                 │
│  ┌──────────────────┐     Service     ┌──────────────────────┐  │
│  │  Frontend Workers │    Binding     │  API Worker           │  │
│  │  (React Router v7)│───────────────▶│  (Hono + Workflows)  │  │
│  │                   │                │                       │  │
│  │  - dashboard      │                │  - Orchestration API  │  │
│  │  - admin          │                │  - Webhooks, CLI      │  │
│  │  - onboarding     │                │  - Triggers Workflows │  │
│  │  - mobile-web     │                │  - Manages sessions   │  │
│  │  - (future apps)  │                │                       │  │
│  │                   │                │  Shared packages:     │  │
│  │  Each does direct │                │  @aicaas/shared       │  │
│  │  CRUD via         │                │  @aicaas/ui-kit       │  │
│  │  Hyperdrive       │                │  @aicaas/ws-client    │  │
│  └──────────┬────────┘                └──────┬───────┬────────┘  │
│             │                                │       │           │
│             │                         ┌──────▼──┐ ┌──▼────────┐  │
│             │                         │Workflows│ │ Durable   │  │
│             │                         │         │ │ Object    │  │
│             │                         │- Multi- │ │           │  │
│             │                         │  step   │─▶- WebSocket│  │
│             │                         │- Durable│ │  hub      │  │
│             │                         │- Retry  │ │- Session  │  │
│             │                         └─────────┘ │  state    │  │
│             │                                     └───────────┘  │
│             │                                                    │
│  ┌──────────▼────────────────────────────────────────────────┐   │
│  │              Hyperdrive + R2                               │   │
│  │  - Hyperdrive: connection pool to Neon Postgres            │   │
│  │  - R2: file/blob storage                                   │   │
│  └──────────────────────────────────┬────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                                      │
                             ┌────────▼───────────┐
                             │   NEON POSTGRES     │
                             │                     │
                             │ - Full Postgres     │
                             │ - pgvector for RAG  │
                             │ - Serverless scale  │
                             └─────────────────────┘
```

---

## 4. Components

### 4.1 React Router v7 — UI Layer

**What it is:** A full-stack React framework (the evolution of Remix). It provides server-side rendering, file-based routing, and data loading/mutation patterns that run on Cloudflare Workers.

**Responsibility:** Each frontend app (dashboard, admin, onboarding, mobile-web) is a separate React Router v7 Worker. Each handles its own UI and **direct CRUD operations** — reads and writes to Postgres that don't involve orchestration. Loaders query the database directly via Hyperdrive. Actions write directly. For orchestration (triggering Workflows, managing agent sessions, streaming LLM calls), loaders and actions delegate to the Hono API Worker via a Service Binding. All frontend apps import shared types, components, and hooks from monorepo packages (`@aicaas/shared`, `@aicaas/ui-kit`, `@aicaas/ws-client`).

**Key concepts:**

- **Loaders** — Functions that run on the server before a page renders. They fetch data and pass it to the component. Think of them as GET handlers: the user navigates to `/agents`, the loader fetches agent data from Postgres, and the component renders it.

- **Actions** — Functions that handle form submissions and mutations. They run on the server when the user submits a form or triggers a mutation. Think of them as POST handlers.

- **SSR (Server-Side Rendering)** — The server runs React components, produces HTML, and sends it to the browser. The user sees content immediately while JavaScript loads in the background. Without SSR, the browser gets an empty page and must download all JS before rendering anything.

**Deployment:** Runs as a Cloudflare Worker via the Cloudflare Vite plugin. Static assets (JS, CSS, images) are served from Workers Assets (free and unlimited). Dynamic pages are server-rendered in the Worker.

**Project structure:**
```
app/
├── routes/
│   ├── _index.tsx          # Home page
│   ├── agents.tsx           # Agent list (loader reads from Postgres directly)
│   ├── agents.$id.tsx       # Single agent view
│   ├── agents.$id.run.tsx   # Run agent (action delegates to Hono)
│   └── agents.new.tsx       # Create agent (action writes to Postgres directly)
├── components/              # App-specific components (import @aicaas/ui-kit for shared ones)
├── lib/                     # App-specific utilities (import @aicaas/shared for types)
└── root.tsx                 # App shell, layout
```

**Direct CRUD — loader reads from Postgres:**
```typescript
// app/routes/agents.tsx — no Hono involved
import postgres from 'postgres';

export async function loader({ context }) {
  const sql = postgres(context.cloudflare.env.HYPERDRIVE.connectionString);
  const agents = await sql`SELECT * FROM agents ORDER BY created_at DESC`;
  return { agents };
}
```

**Direct CRUD — action writes to Postgres:**
```typescript
// app/routes/agents.new.tsx — no Hono involved
import postgres from 'postgres';

export async function action({ request, context }) {
  const form = await request.formData();
  const sql = postgres(context.cloudflare.env.HYPERDRIVE.connectionString);
  await sql`INSERT INTO agents (name, type) VALUES (${form.get('name')}, ${form.get('type')})`;
  return redirect('/agents');
}
```

**Orchestration — action delegates to Hono:**
```typescript
// app/routes/agents.$id.run.tsx — orchestration goes through Hono
export async function action({ request, params, context }) {
  const form = await request.formData();
  const api = context.cloudflare.env.API;  // Service Binding to Hono Worker

  const res = await api.fetch(`/api/agents/${params.id}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      task: form.get('task'),
      sessionId: form.get('sessionId'),
    }),
  });

  return res.json();
}
```

**Note on Service Binding patterns:** The example above uses `api.fetch()` which works like an internal HTTP call. Cloudflare also supports type-safe RPC via `WorkerEntrypoint` for Worker-to-Worker communication, which avoids stringly-typed URL paths. For internal frontend→API calls, RPC is cleaner. Keep HTTP routes for external clients (CLI, webhooks, agent-to-agent). Both patterns work through Service Bindings with zero-latency and no additional request costs. Start with `fetch()` (simpler, matches the Hono router), migrate to RPC for internal calls when the API surface grows.

### 4.2 Hono — Orchestration Layer

**What it is:** A lightweight web framework (~14KB) for building APIs. Express-like syntax, first-class TypeScript, purpose-built for edge runtimes.

**Responsibility:** Hono handles everything that involves **coordination across multiple services**: triggering Workflows, managing Durable Object sessions, proxying streaming LLM calls, accepting webhooks from external systems, and serving non-browser clients (CLI tools, agent-to-agent communication). It does not handle simple reads or writes to the database — those stay in React Router v7 loaders and actions.

**Workflows live in the same Worker.** The Workflow classes are exported from the same project as the Hono app. They share bindings (Hyperdrive, Durable Objects) and change together — a new Workflow step usually comes alongside a new Hono endpoint that triggers it. No need for a separate deployment.

**Deployment:** Runs as its own Cloudflare Worker. The React Router v7 Worker calls it via a Service Binding for orchestration tasks. External clients (CLI, webhooks, other agents) call it directly via HTTP.

**Example:**
```typescript
// src/index.ts
import { Hono } from 'hono';

// Generate this with `wrangler types` instead of hand-writing.
// It reads your wrangler.jsonc bindings and produces a typed Env interface.
type Bindings = {
  HYPERDRIVE: Hyperdrive;
  AGENT_WORKFLOW: Workflow;
  AGENT_SESSIONS: DurableObjectNamespace;
  ANTHROPIC_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Orchestration: trigger a multi-step agent workflow
app.post('/api/agents/:id/run', async (c) => {
  const instance = await c.env.AGENT_WORKFLOW.create({
    params: {
      agentId: c.req.param('id'),
      sessionId: c.req.header('x-session-id'),
      task: await c.req.json(),
    },
  });
  return c.json({ status: 'dispatched', instanceId: instance.id });
});

// Orchestration: stream LLM response directly
app.post('/api/agents/:id/chat', async (c) => {
  const body = await c.req.json();
  const llmResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': c.env.ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ stream: true, model: 'claude-sonnet-4-5-20250514', ...body }),
  });
  return new Response(llmResponse.body, {
    headers: { 'Content-Type': 'text/event-stream' },
  });
});

// Webhooks: external systems push events
app.post('/api/webhooks/slack', async (c) => {
  const event = await c.req.json();
  await c.env.AGENT_WORKFLOW.create({
    params: { source: 'slack', event },
  });
  return c.json({ ok: true });
});

// Workflow status: query from CLI or UI
app.get('/api/workflows/:id/status', async (c) => {
  const instance = await c.env.AGENT_WORKFLOW.get(c.req.param('id'));
  return c.json({ status: instance.status });
});

export default app;

// Workflow class — exported from the same Worker
export { AgentWorkflow } from './workflows/agent';
// Durable Object class
export { AgentSession } from './durable-objects/session';
```

### 4.3 Durable Objects — Stateful Edge Compute

**What they are:** Single-threaded JavaScript objects with their own private storage (SQLite, up to 10GB per object). Requests to the same object are always routed to the same instance, globally. Think of them as the **actor model** — each object is an actor with private state and guaranteed single-threaded execution.

**Why they matter for AICaaS:** Each active agent session can be a Durable Object. It holds the session's conversation state, manages WebSocket connections to the browser for real-time updates, and coordinates task dispatch. No external database needed for hot session state.

**Key properties:**
- **Global uniqueness** — One instance per ID, worldwide. If two users hit the same agent session from different continents, both requests route to the same Durable Object.
- **Single location** — A DO runs in one datacenter (chosen by Cloudflare based on first request). This is a feature for coordination (no distributed state), but means it's not a nearest-edge cache. Stateless edge execution stays in Workers.
- **Hibernatable WebSockets** — WebSocket connections can be "hibernated" so idle connections don't incur compute charges. The object wakes up only when a message arrives.
- **CPU limits** — 30 seconds of CPU time per incoming request (configurable higher). This resets with each new request. Time spent waiting on I/O (LLM calls, database queries) doesn't count.
- **SQLite storage** — Each object has its own embedded SQLite database (10GB max per object on paid plan). No shared state between objects unless explicitly coordinated.
- **Throughput** — Soft limit of ~1,000 requests/sec per individual object. If a single DO receives more, requests queue and latency increases.

**Sharding strategy:** One DO per session, not one giant hub. Create separate DOs for separate concerns:
- `AGENT_SESSIONS.idFromString(sessionId)` — one per active agent session (WebSocket hub + live state)
- When rate limiting is added later: `RATE_LIMITERS.idFromName('anthropic')` — one per LLM provider
- For per-tenant isolation: `AGENT_SESSIONS.idFromName(`${orgId}-${sessionId}`)` — scoped by organization

Avoid funneling all traffic through a single DO instance. If 500 users are active simultaneously, that's 500 separate Agent Session DOs, each handling its own WebSocket connections — not one DO handling 500 connections.

**Billing:** Charged for wall-clock duration while active, plus storage. Hibernated objects (idle WebSocket connections) are free. SQLite storage billing applies.

### 4.4 Rate Limiting External APIs (Add When Needed)

At launch, rely on the LLM provider's own 429 responses and Workflow's built-in retry. When you start seeing retry storms in your logs (typically at 50+ concurrent users), add a Rate Limiter Durable Object.

**The pattern:** A Durable Object per external service acts as a globally-consistent rate limiter. Because `idFromName('anthropic')` resolves to the same single-threaded instance worldwide, it has a perfect count of in-flight requests — no race conditions, no distributed coordination.

The rate limiter holds an in-memory queue of waiting requests. When a slot opens, it drains the queue. If the backlog is too deep or a request waits too long, it rejects — and the Workflow retries the step later when capacity is available. An alarm resets per-minute counters.

**When to add:** You observe cascading 429 retries across Workflow instances. The rate limiter shapes traffic centrally instead of each Workflow retrying independently.

**Change:** Add a `RateLimiter` Durable Object class to the API Worker. Workflow steps call through it instead of calling external APIs directly. Hono streaming endpoints can also use it, but for interactive requests consider returning a "busy" response to the user rather than making them wait in a queue.

### 4.5 Streaming — Text and Audio

**Two interaction modes** exist in the architecture, each with a different streaming approach:

**Interactive (streaming tokens):** User sends a message, expects tokens back in real time. The Worker proxies the LLM's streaming response directly to the browser. CPU cost is near-zero — the Worker just moves bytes between two I/O streams. At launch, the Hono endpoint calls the LLM directly. When rate limiting is added later, the call can be routed through a Rate Limiter Durable Object.

Or via a Durable Object for multi-client broadcast: the Durable Object calls the LLM, streams tokens through WebSocket to all connected browsers showing the same agent session.

**Background (status updates):** User triggers a complex multi-step task, doesn't sit and watch token by token. Workflow steps push structured status updates to a Durable Object, which broadcasts via WebSocket:

```typescript
// Inside a Workflow step
const session = this.env.AGENT_SESSIONS.get(
  this.env.AGENT_SESSIONS.idFromString(event.payload.sessionId)
);
await session.fetch('http://internal/update', {
  method: 'POST',
  body: JSON.stringify({
    status: 'calling-llm',
    step: 2,
    totalSteps: 4,
    agentName: 'PULSE Analyst',
  }),
});
```

The browser receives a live progress feed: "building prompt..." → "thinking..." → "analyzing results..." → "done." This is better than token streaming for background tasks — you get structured progress objects with step numbers, agent names, and percentages.

**Audio:** Text-to-speech (TTS API → Worker proxies audio stream) and speech-to-text (browser sends audio chunks → Worker forwards to transcription API) work the same way as text streaming — Workers proxy bytes, CPU cost is negligible. Real-time bidirectional voice conversation is best handled client-side (browser WebSocket direct to a voice API like OpenAI Realtime), with your backend handling orchestration only.

### 4.6 Cloudflare Workflows — Durable Multi-Step Orchestration

**What they are:** A way to define multi-step processes that survive failures and restarts. Each step is a function that can make API calls, sleep, or branch. If a step fails, the Workflow retries it automatically. If the Worker is evicted, the Workflow resumes from the last completed step.

**Why they matter for AICaaS:** Agent chains are multi-step: call LLM → parse response → decide next action → call LLM again → store result. Each step might fail (LLM timeout, rate limit). Workflows handle retry logic, state persistence between steps, and long-running execution without you building a state machine from scratch.

**Critical rule: steps must be idempotent.** Steps may retry after a failure, which means any side effects (database writes, API calls, notifications) could execute more than once. Use idempotency keys for writes: `INSERT ... ON CONFLICT DO NOTHING`, or check for existing records before creating. For LLM calls, a retry is usually safe (you get a different response, which is fine). For payment or webhook calls, idempotency matters.

**Hard limits (paid plan):**

| Limit | Value |
|-------|-------|
| Event payload | 1 MiB |
| Persisted state per step (return value) | 1 MiB |
| Persisted state per Workflow instance | 1 GB |
| Max step duration (CPU time) | 30 seconds (resets per step) |
| Concurrent Workflow instances | 10,000 active (sleeping/waiting instances are unlimited) |

The 1 MiB per-step limit is the most important for agent systems. A 100K-token conversation history exceeds this easily. Use the Claim Check Pattern (see Section 12): save large data to R2 or Postgres, pass only the reference between steps.

**Billing:** Same as Workers — CPU time only. A Workflow sleeping or waiting on an API call costs nothing.

**Example (with status updates and rate limiting):**
```typescript
export class AgentWorkflow extends WorkflowEntrypoint {
  async run(event: WorkflowEvent, step: WorkflowStep) {
    const { agentId, sessionId, task } = event.payload;

    // Helper: push status update to client via Durable Object → WebSocket
    const notify = async (status: string, stepNum: number) => {
      const session = this.env.AGENT_SESSIONS.get(
        this.env.AGENT_SESSIONS.idFromString(sessionId)
      );
      await session.fetch('http://internal/update', {
        method: 'POST',
        body: JSON.stringify({ status, step: stepNum, totalSteps: 5 }),
      });
    };

    // Helper: call LLM (retried automatically by Workflows on failure)
    const callLLM = async (messages: any[]) => {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: 'claude-sonnet-4-5-20250514', messages }),
      });
      if (!res.ok) throw new Error(`LLM error: ${res.status}`); // Triggers Workflow retry
      return res.json();
    };

    // Step 1: Build prompt
    const prompt = await step.do('build-prompt', async () => {
      await notify('building-prompt', 1);
      const sql = postgres(this.env.HYPERDRIVE.connectionString);
      const context = await sql`
        SELECT * FROM agent_context WHERE agent_id = ${agentId}
      `;
      return assemblePrompt(context, task);
    });

    // Step 2: Call LLM (if 429'd, Workflow retries the step automatically)
    const response = await step.do('call-llm', async () => {
      await notify('thinking', 2);
      return await callLLM([{ role: 'user', content: prompt }]);
    });

    // Step 3: Decide next action
    const decision = await step.do('decide', async () => {
      await notify('analyzing', 3);
      return parseDecision(response);
    });

    // Step 4: Optional follow-up
    if (decision.needsFollowUp) {
      await step.do('follow-up', async () => {
        await notify('follow-up', 4);
        return await callLLM(decision.followUpMessages);
      });
    }

    // Step 5: Store result and notify completion
    await step.do('store-result', async () => {
      const sql = postgres(this.env.HYPERDRIVE.connectionString);
      await sql`
        INSERT INTO results (agent_id, output, created_at)
        VALUES (${agentId}, ${JSON.stringify(decision)}, NOW())
      `;
      await notify('done', 5);
    });
  }
}
```

### 4.7 Storage

| Service | Use Case | Launch? |
|---------|----------|---------|
| **Neon Postgres + Hyperdrive** | Structured data, vector embeddings (pgvector), all relational queries | Yes |
| **R2** | File uploads, large agent outputs, document storage (S3-compatible, no egress fees) | Yes |
| **KV** | High-read caching, feature flags, session tokens (eventually consistent, ~60s propagation) | Add when needed |

At launch, Hyperdrive's built-in query caching (60s TTL for cacheable queries) covers most caching needs. KV becomes worthwhile when you need cache TTL control beyond what Hyperdrive offers, when you have queries that aren't cacheable (those using `NOW()`, `random()`, etc.), or when you have read-heavy data that doesn't belong in Postgres (feature flags, session tokens at scale).

Neon is accessed through a Hyperdrive binding (`env.HYPERDRIVE`) which provides a standard Postgres connection string. R2 is accessed via a binding (`env.STORAGE`).

**Why Neon instead of D1:** D1 is Cloudflare's built-in SQLite database. It's simple and cheap but limited: 10GB per database, no extensions, no pgvector, no stored procedures, no ecosystem of Postgres tooling. Neon gives you full Postgres — pgvector for RAG/semantic search, proper migrations with Drizzle or Prisma, JSONB, full-text search, CTEs, window functions, and the entire Postgres extension ecosystem. Since the AICaaS platform needs vector embeddings for the Memory layer and complex relational queries for agent orchestration history, Postgres is the right choice.

**Why Hyperdrive:** Workers are stateless — they can't hold persistent database connections. Without Hyperdrive, every Worker invocation would establish a new TCP + TLS + auth handshake with Neon (~6 network round trips). Hyperdrive maintains a global pool of warm connections distributed across Cloudflare's network. Your Worker connects to the nearest Hyperdrive node (near-zero latency), which reuses an existing connection to Neon. It also provides query caching for cacheable queries (enabled by default, 60s TTL). Not all queries are cacheable — queries using PostgreSQL STABLE functions like `NOW()`, `CURRENT_TIMESTAMP`, or `random()` are treated as uncacheable. Parameterized queries with static structure are the best candidates for caching. Hyperdrive is included in the Workers Paid plan.

**Important:** Do not use Neon's built-in connection pooler (PgBouncer) alongside Hyperdrive. Hyperdrive maintains its own global pool, making Neon's pooling redundant. Connect Hyperdrive directly to the Neon database endpoint, not the pooled endpoint.

### 4.8 AI Gateway (Early Extension)

**What it is:** Cloudflare's managed proxy for LLM API calls. Sits between your Workers and LLM providers (Anthropic, OpenAI, etc.), providing logging, analytics, caching, rate limiting, retries, and model fallback — without code changes beyond swapping the base URL.

**Why it matters for AICaaS:** This platform's primary cost and reliability concerns are LLM API calls. AI Gateway addresses them at the infrastructure level:

| Concern | AI Gateway feature |
|---------|-------------------|
| **Cost visibility** | Per-request logging with token counts, latency, cost — feeds into Better Stack dashboards |
| **Cost reduction** | Response caching for identical prompts (common in agent systems with templated prompts) |
| **Reliability** | Automatic retries with backoff, model fallback (Anthropic → OpenAI if provider is down) |
| **Rate limiting** | Built-in rate limiting per gateway, simpler than the Durable Object rate limiter for basic cases |
| **Compliance** | Request/response logging for audit trails |

**When to add:** Consider this an early extension — add it when you start making real LLM calls in development, before production. The setup is a one-line URL change:

```typescript
// Before: direct call to Anthropic
const res = await fetch('https://api.anthropic.com/v1/messages', { ... });

// After: route through AI Gateway
const res = await fetch(
  'https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_name}/anthropic/v1/messages',
  { ... }
);
```

Headers, body, and response format stay the same. AI Gateway proxies transparently.

**Relationship to the Rate Limiter DO:** AI Gateway provides basic rate limiting and retries at the gateway level. The Durable Object rate limiter (Section 4.4) provides fine-grained concurrency control with backpressure. Start with AI Gateway alone; add the DO rate limiter only if you need per-tenant limits or custom queuing logic.

### 4.9 Knowledge Layer — SurrealDB (Add When Building Memory)

**What it is:** SurrealDB is a multi-model database that combines relational, graph, vector, document, and real-time capabilities in one engine with one query language (SurrealQL). It serves as the knowledge and memory layer for AI agents — complementing Neon Postgres (which handles CRUD) with the relationship-centric, vector-aware, permission-enforced data that agents need for reasoning.

**Why not Neo4j?** Neo4j Aura was evaluated and has deeper graph traversal performance and a more mature GraphRAG ecosystem. However, for this platform's agent workloads, the primary need is multi-model reasoning: "find similar documents AND traverse their relationships AND check permissions" in one step. SurrealDB does this in one query. With Neo4j + pgvector, that requires two separate database calls and a merge step in TypeScript. SurrealDB's built-in permissions also solve the auth duplication problem (Section 12) at the database level. Neo4j remains a valid choice if deep graph traversal (10+ hops) or the LangChain/LlamaIndex GraphRAG ecosystem become critical differentiators.

**What it replaces and what it doesn't:**

| Data | Store | Why |
|------|-------|-----|
| Users, orgs, agents, config, task history | **Neon Postgres** (unchanged) | Proven relational CRUD, Hyperdrive connection pooling, full Postgres ecosystem |
| File uploads, large outputs, blobs | **R2** (unchanged) | Object storage |
| Hot session state, WebSocket connections | **Durable Objects** (unchanged) | Real-time, ephemeral |
| Knowledge graphs, entity relationships | **SurrealDB** (new) | Graph traversal + vector + permissions in one query |
| Agent memory, decision trails, learning | **SurrealDB** (new) | Relationship-centric data that grows over time |
| Document embeddings for RAG | **SurrealDB** (new) | Vector search combined with graph context (GraphRAG in one query) |
| Company documentation structure | **SurrealDB** (new) | Org charts, policies, processes as a navigable graph |

**Use cases for AICaaS:**

**GraphRAG in one query.** pgvector finds "the 10 most similar documents." SurrealDB finds "the 10 most similar documents, their authors, the policies they reference, and the teams responsible for those policies" — vector similarity + graph traversal combined:

```sql
-- SurrealQL: vector search + graph traversal in one query
SELECT
  doc.title,
  doc.content,
  doc->authored_by->person.name AS author,
  doc->references->policy.title AS policies,
  doc->references->policy->owned_by->team.name AS responsible_teams
FROM document AS doc
WHERE embedding <|10|> $query_embedding
AND org = $org_id;
```

**Agent memory graph.** Every agent interaction becomes a node connected to its context, decisions, outcomes, and feedback. MINT agents query the memory graph to build observational knowledge: "Show me all the times an agent recommended a pricing change, what data it used, and whether the recommendation was accepted."

**Company domain modeling.** When a customer onboards, extract their documentation into a knowledge graph per tenant. Departments → roles → policies → processes → tools. Agents consult this graph for context-aware decisions. A logistics company's graph looks different from a law firm's.

**Audit and explainability.** Trace any agent decision back to its sources: input data → retrieved context → agent reasoning → downstream effects. Walk the graph from any decision node to its origins.

**Permission-enforced queries.** SurrealDB's record-level permissions ensure agents can only access data they're authorized for. Define rules once at the database level — both React Router loaders and Workflow steps are subject to the same rules. Solves the auth duplication problem from Section 12 for the knowledge layer.

**Cloudflare Workers integration:** SurrealDB exposes an HTTP REST API and a WebSocket API. From Workflow steps, use the HTTP API (same pattern as any external service call). No Hyperdrive equivalent exists, so each call is a fresh HTTP request — acceptable for Workflow steps where the overhead is invisible in a multi-second agent chain, but not suitable for real-time UI loaders (those stay on Neon + Hyperdrive).

```typescript
// Inside a Workflow step — query SurrealDB for agent context
const knowledge = await step.do('get-knowledge', async () => {
  const res = await fetch(`${this.env.SURREALDB_URL}/sql`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${this.env.SURREAL_USER}:${this.env.SURREAL_PASS}`)}`,
      'surreal-ns': 'aicaas',
      'surreal-db': orgId,  // Per-tenant database
      'Accept': 'application/json',
    },
    body: `
      SELECT
        doc.title, doc.content,
        doc->references->policy.title AS policies
      FROM document AS doc
      WHERE embedding <|10|> $embedding
      AND org = $org_id;
    `,
  });
  return res.json();
});
```

**When to add:** Not needed at launch. Add when building the Memory layer (MINT team) or when agents need relationship-aware context beyond flat vector similarity. The progression:

1. **Launch:** pgvector in Neon for basic RAG (already in the spec)
2. **Memory layer:** Add SurrealDB (Cloud free tier or self-hosted on Fly.io) for knowledge graphs and agent memory. Workflow steps query both Neon (CRUD) and SurrealDB (knowledge). Validate with one customer.
3. **Production scale:** Upgrade to SurrealDB Cloud paid tier or scale the Fly.io instance.

**Pricing:**

| Option | Cost | When |
|--------|------|------|
| SurrealDB Cloud free tier | $0 | Prototyping, single-customer pilot |
| SurrealDB Cloud Start | ~$15/month (usage-based, $0.02/hr) | Production with multiple tenants |
| Self-hosted on Fly.io | ~$2.52/month (shared-cpu-1x) + Fly.io compute | Cost-sensitive production, co-located with other Fly.io workloads |

---

## 5. Infrastructure as Code

All Cloudflare resources are managed with Terraform using the Cloudflare provider. Application code is deployed with Wrangler (Cloudflare's CLI); infrastructure is provisioned with Terraform.

**Division of responsibility:**
- **Terraform** manages: Hyperdrive configs, R2 buckets, DNS records, custom domains, Workers routes, environment variables, secrets. Neon database provisioning is managed via the Neon console or Neon's own Terraform provider.
- **Wrangler** manages: Worker code deployment, Durable Object migrations, local development. Each Worker project has its own `wrangler.jsonc`.

### Monorepo with Turborepo

The project is a pnpm monorepo managed by Turborepo. Multiple frontend apps share types, components, and a typed API client. Turborepo handles build ordering (packages before apps), parallel execution, and caching — when a shared package hasn't changed, downstream apps skip rebuilding it.

**Why Turborepo:** The platform will have multiple frontend variations (dashboard, admin, onboarding, mobile-optimized). These share types, design tokens, React components, and a WebSocket client. A monorepo with shared packages avoids duplicating this code across repos. Turborepo is the lightest real monorepo tool — just a task runner with caching on top of pnpm workspaces. No runtime, no plugin system, no framework lock-in.

### Project Layout

```
pnpm-workspace.yaml          # Declares workspace packages
turbo.json                    # Task pipeline config
package.json                  # Root scripts, devDependencies

packages/
├── shared/                   # Types, constants, API client
│   ├── src/
│   │   ├── types.ts                # Agent, Task, WorkflowStatus
│   │   ├── api-client.ts           # Typed Hono RPC client
│   │   └── constants.ts            # Routes, error codes
│   ├── package.json                # @aicaas/shared
│   └── tsconfig.json
├── ui-kit/                   # Shared React components, design tokens
│   ├── src/
│   │   ├── components/             # Button, Modal, AgentCard, etc.
│   │   ├── hooks/                  # useWebSocket, useAgentStream
│   │   └── tokens.css              # Tailwind config, design tokens
│   ├── package.json                # @aicaas/ui-kit
│   └── tsconfig.json
└── ws-client/                # WebSocket client for Durable Object
    ├── src/
    │   └── index.ts                # Connect, reconnect, parse updates
    ├── package.json                # @aicaas/ws-client
    └── tsconfig.json

apps/
├── dashboard/                # Main product UI (React Router v7)
│   ├── app/
│   ├── wrangler.jsonc
│   ├── vite.config.ts
│   └── package.json
├── api/                      # Hono + Workflows + Durable Objects
│   ├── src/
│   │   ├── index.ts                # Hono app entry + exports
│   │   ├── workflows/
│   │   │   └── agent.ts            # AgentWorkflow class
│   │   └── durable-objects/
│   │       └── session.ts          # AgentSession class
│   ├── wrangler.jsonc
│   └── package.json
└── (future frontends)        # admin/, onboarding/, mobile-web/

infra/
├── main.tf
├── variables.tf
├── outputs.tf
├── workers.tf
├── storage.tf
├── dns.tf
├── environments/
│   ├── staging.tfvars
│   └── production.tfvars
└── modules/
    └── flyio/
        ├── main.tf
        └── variables.tf
```

**Typed API client via Hono RPC:** Hono supports exporting route types. Every frontend gets a fully typed client that knows every endpoint, parameter, and response shape — one definition, zero drift:

```typescript
// packages/shared/src/api-client.ts
import { hc } from 'hono/client';
import type { AppType } from '@aicaas/api';

export const createApiClient = (baseUrl: string) => hc<AppType>(baseUrl);

// In any frontend app
const api = createApiClient('https://api.aicaas.dev');
const result = await api.agents[':id'].run.$post({
  param: { id: '123' },
  json: { task: 'analyze org structure' },
}); // Fully typed — IDE autocompletes endpoints and params
```

**Root configuration:**

```yaml
# pnpm-workspace.yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "dev": {
      "persistent": true,
      "cache": false
    },
    "deploy": {
      "dependsOn": ["build"]
    }
  }
}
```

**Common commands:**

```bash
# Install all dependencies across workspace
pnpm install

# Dev — run specific app
turbo run dev --filter=dashboard
turbo run dev --filter=api

# Build everything (packages first, then apps in parallel)
turbo run build

# Deploy a single app (builds only its dependencies)
turbo run deploy --filter=dashboard
turbo run deploy --filter=api

# Add a new frontend — create directory, add wrangler.jsonc, import from shared packages
mkdir apps/admin && cd apps/admin
# New frontend immediately has access to @aicaas/shared, @aicaas/ui-kit, @aicaas/ws-client
```

### Terraform Configuration

```hcl
# main.tf
terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# storage.tf
resource "cloudflare_hyperdrive_config" "neon" {
  account_id = var.cloudflare_account_id
  name       = "aicaas-neon-${var.environment}"

  origin = {
    host     = var.neon_host       # e.g. ep-cool-darkness-123456.us-east-2.aws.neon.tech
    port     = 5432
    database = var.neon_database
    user     = var.neon_user
    password = var.neon_password
    scheme   = "postgres"
  }

  caching = {
    disabled = false  # Query caching enabled (60s default TTL, cacheable queries only)
  }
}

resource "cloudflare_r2_bucket" "storage" {
  account_id = var.cloudflare_account_id
  name       = "aicaas-storage-${var.environment}"
}
```

### Wrangler Configuration (Dashboard Worker — React Router v7)

```jsonc
// apps/dashboard/wrangler.jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "aicaas-dashboard",
  "compatibility_date": "2026-03-01",
  "compatibility_flags": ["nodejs_compat"],

  // Direct CRUD: loaders and actions query Postgres directly
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "$HYPERDRIVE_CONFIG_ID",
      "localConnectionString": "postgres://user:pass@localhost:5432/aicaas_dev"
    }
  ],

  // Orchestration: delegate to Hono API Worker via Service Binding
  "services": [
    { "binding": "API", "service": "aicaas-api" }
  ]
}
```

### Wrangler Configuration (API Worker — Hono + Workflows + Durable Objects)

```jsonc
// apps/api/wrangler.jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "aicaas-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-03-01",
  "compatibility_flags": ["nodejs_compat"],

  // Workflows need DB access for building prompts and storing results
  "hyperdrive": [
    {
      "binding": "HYPERDRIVE",
      "id": "$HYPERDRIVE_CONFIG_ID",
      "localConnectionString": "postgres://user:pass@localhost:5432/aicaas_dev"
    }
  ],
  "r2_buckets": [
    { "binding": "STORAGE", "bucket_name": "aicaas-storage-production" }
  ],
  "durable_objects": {
    "bindings": [
      { "name": "AGENT_SESSIONS", "class_name": "AgentSession" }
    ]
  },
  "workflows": [
    { "binding": "AGENT_WORKFLOW", "name": "agent-workflow", "class_name": "AgentWorkflow" }
  ]
}
```

---

## 6. Deployment

### Local Development

Each app runs locally with Wrangler, which uses the `workerd` runtime (same as production).

```bash
# Run a specific app
turbo run dev --filter=api
turbo run dev --filter=dashboard

# Or run both in parallel
turbo run dev --filter=api --filter=dashboard
```

The Cloudflare Vite plugin runs the dev server inside `workerd`, so bindings to Hyperdrive, R2, Durable Objects, and Workflows all work locally. No mocking, no workarounds.

### Production Deployment

```bash
# Infrastructure (one-time or on changes)
cd infra && terraform apply -var-file=environments/production.tfvars

# Deploy a single app (builds only its dependencies first)
turbo run deploy --filter=api
turbo run deploy --filter=dashboard

# Deploy everything
turbo run deploy
```

For CI/CD, use Workers Builds (Cloudflare's native CI) or GitHub Actions with the `cloudflare/wrangler-action`.

---

## 7. Observability, Metrics, and Alerts

Start with the final monitoring stack from day one. Build support workflows, runbooks, and alerting habits while stakes are low — not during your first production incident.

### Stack

| Concern | Tool | Why |
|---------|------|-----|
| **Logs** | Better Stack | SQL-based log search, no proprietary query language to learn |
| **Uptime monitoring** | Better Stack | Checks API Worker, dashboard Workers, Neon availability |
| **Alerting & on-call** | Better Stack | Escalation policies, schedules, integrations (Slack, email, SMS) |
| **Status page** | Better Stack | Customer-facing status for an AICaaS product |
| **Cost monitoring** | Better Stack | SQL queries over Logpush data: CPU cost, LLM token spend, DO duration, per-agent costs |
| **Custom dashboards** | Better Stack APIs | SQL Query API (logs/metrics), Incidents API (CRUD), Status Page JSON API (public). Embed in your own admin panel |
| **Deep tracing** | Cloudflare Workers Observability | Built-in OpenTelemetry traces across Workers, Workflows, Durable Objects — free |
| **Metrics** | Cloudflare Workers Observability | Request counts, error rates, CPU time, wall time — built into the dashboard |

Better Stack handles the operational side: is everything up, who gets paged when it's not, and what do customers see. Cloudflare's built-in observability handles the debugging side: trace a request through Workers → Workflows → Durable Objects, query logs across all Workers, inspect CPU time per invocation.

### Why Better Stack

Better Stack bundles uptime monitoring, logs, on-call alerting, and status pages in one product. The alternative is assembling these from separate tools: Axiom for logs ($0-25/mo) + UptimeRobot for monitoring ($7/mo) + PagerDuty for on-call ($0-20/mo) + Instatus for status pages ($0-20/mo). Better Stack at ~$29/month is cheaper than the bundle, simpler to manage, and uses standard SQL for log queries — which you already know from Postgres.

Grafana Cloud was considered for its deeper tracing (Tempo) and richer dashboards. But it's more complex: LogQL for logs, PromQL for metrics, a dashboard builder with a learning curve. For a solo developer, "simple and complete" beats "deep but complex." If distributed tracing across Workers → Neon → LLM providers becomes critical later, Cloudflare's built-in OTLP export can send traces to Grafana Cloud alongside Better Stack — they're not mutually exclusive.

### Setup

**Better Stack** — receives logs via Cloudflare Logpush or a Tail Worker:

```jsonc
// apps/api/wrangler.jsonc — add observability
{
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1  // Log 100% of requests (adjust down for high traffic)
  }
}
```

Configure a Logpush job in the Cloudflare dashboard to forward Workers trace events to Better Stack's HTTP endpoint. Better Stack provides a source URL — plug it into Logpush as the destination.

**Cloudflare Tracing (open beta)** — enable in Wrangler for deep debugging. Currently free during beta; pricing will align with Workers Logs events when GA:

```jsonc
{
  "observability": {
    "enabled": true,
    "traces": {
      "enabled": true,
      "head_sampling_rate": 1
    }
  }
}
```

Traces appear in the Cloudflare dashboard under Workers → Observability. Automatically instruments Worker invocations, subrequests, KV/R2/D1 calls, Durable Object interactions, and Workflow steps. No SDK or code changes needed.

### What to Monitor

| Monitor | Type | Alert |
|---------|------|-------|
| API Worker health | Uptime check (HTTPS) | Down > 1 min → page on-call |
| Dashboard Worker health | Uptime check (HTTPS) | Down > 1 min → page on-call |
| Neon database | Uptime check (TCP to Neon host) | Down > 2 min → page on-call |
| Workflow failure rate | Log-based alert (Better Stack) | > 5 failed Workflows in 10 min → Slack notification |
| LLM provider errors | Log-based alert (Better Stack) | > 10 429s in 5 min → Slack notification (pre-rate-limiter signal) |
| CPU time spikes | CF dashboard metrics | p95 CPU > 10s → investigate (may need Fly.io migration) |
| Error rate | CF dashboard metrics | Error rate > 5% → investigate |

### Structured Logging

Log in JSON format from Hono and Workflows so Better Stack can index fields automatically:

```typescript
// Structured log — Better Stack indexes every field
console.log(JSON.stringify({
  event: 'workflow_step_completed',
  workflowId: instance.id,
  agentId: agentId,
  step: 'call-llm',
  durationMs: 2340,
  llmProvider: 'anthropic',
  tokensUsed: 1520,
}));
```

This lets you query in Better Stack with standard SQL: `SELECT * FROM logs WHERE agentId = 'abc' AND event = 'workflow_step_completed' ORDER BY _time DESC`.

### Cost Monitoring

Better Stack doubles as your cost dashboard. Cloudflare's OTLP export doesn't support metrics yet, but every Logpush event includes `cpuTimeMs` and `wallTimeMs` per invocation — the raw data you need to compute exactly what you're being billed for.

Your real costs come from five sources: Workers CPU time, Durable Object duration, R2 operations, Hyperdrive queries, and LLM tokens. By logging cost-relevant data as structured events, Better Stack gives you a single place to monitor all of them.

**Log LLM costs from Workflow steps:**

```typescript
await step.do('call-llm', async () => {
  const result = await callLLM(messages);

  console.log(JSON.stringify({
    event: 'llm_call',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250514',
    inputTokens: result.usage.input_tokens,
    outputTokens: result.usage.output_tokens,
    estimatedCostUsd: (result.usage.input_tokens * 0.003 + result.usage.output_tokens * 0.015) / 1000,
    agentId,
    workflowId: instance.id,
  }));

  return result;
});
```

**Cost queries in Better Stack (standard SQL):**

```sql
-- Daily CPU cost per Worker (Cloudflare bills $0.02 per million CPU-ms)
SELECT
  scriptName,
  SUM(cpuTimeMs) / 1000000 * 0.02 AS estimated_cpu_cost_usd,
  COUNT(*) AS total_requests,
  AVG(cpuTimeMs) AS avg_cpu_ms
FROM logs
WHERE _time > NOW() - INTERVAL 1 DAY
GROUP BY scriptName

-- Daily LLM spend by provider (your largest variable cost)
SELECT
  provider,
  model,
  SUM(estimatedCostUsd) AS total_cost,
  SUM(inputTokens) + SUM(outputTokens) AS total_tokens,
  COUNT(*) AS calls
FROM logs
WHERE event = 'llm_call' AND _time > NOW() - INTERVAL 1 DAY
GROUP BY provider, model

-- Per-agent LLM cost (which agents are expensive?)
SELECT
  agentId,
  SUM(estimatedCostUsd) AS total_cost,
  COUNT(*) AS calls
FROM logs
WHERE event = 'llm_call' AND _time > NOW() - INTERVAL 7 DAY
GROUP BY agentId
ORDER BY total_cost DESC

-- Spot runaway costs: which endpoints use the most CPU?
SELECT
  scriptName,
  request_url,
  AVG(cpuTimeMs) AS avg_cpu_ms,
  COUNT(*) AS invocations
FROM logs
WHERE _time > NOW() - INTERVAL 1 HOUR
GROUP BY scriptName, request_url
ORDER BY AVG(cpuTimeMs) * COUNT(*) DESC
LIMIT 20
```

**Cost alerts:**

| Alert | Condition | Action |
|-------|-----------|--------|
| LLM budget spike | `SUM(estimatedCostUsd) WHERE event = 'llm_call'` > $10 in 1 hour | Slack notification — catch runaway agent loops |
| CPU cost spike | `SUM(cpuTimeMs)` > 1,000,000ms in 1 hour for any Worker | Investigate — may indicate a code regression or unexpected traffic |
| Durable Object duration | Logs showing sustained active DO time | Track against billing — hibernation should keep this low |

This approach is more powerful than Cloudflare's built-in dashboard metrics because you control the cost model. Cloudflare shows you CPU time; Better Stack shows you the dollar amount across all cost dimensions — CPU, Durable Objects, LLM tokens — in one query.

### Better Stack APIs — Embed in Your Own Dashboards

Better Stack exposes three APIs that let you build observability features directly into your admin panel and customer-facing UI. No need to send users to Better Stack's dashboard — pull the data into your own app.

**SQL Query API** — query logs, spans, and metrics over HTTP. Built on ClickHouse. Use it for cost dashboards, usage analytics, and custom reporting:

```typescript
// packages/shared/src/better-stack.ts
export async function queryLogs(sql: string) {
  const res = await fetch('https://telemetry.betterstack.com/', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${btoa(`${username}:${password}`)}`,
      'Content-Type': 'text/plain',
    },
    body: `${sql} FORMAT JSONEachRow SETTINGS output_format_json_array_of_rows = 1`,
  });
  return res.json();
}
```

Supports JSON, JSONEachRow, CSV, TSV output formats. 4 concurrent queries for logs, 20 for metrics.

**Incidents API** — list, create, acknowledge, and resolve incidents programmatically:

```typescript
// Hono endpoint: list active incidents for admin dashboard
app.get('/api/admin/incidents', async (c) => {
  const res = await fetch(
    'https://uptime.betterstack.com/api/v3/incidents?resolved=false',
    { headers: { 'Authorization': `Bearer ${c.env.BETTERSTACK_TOKEN}` } }
  );
  return c.json(await res.json());
});

// Create an incident from application logic
// e.g. a Workflow detects an agent stuck in a retry loop
app.post('/api/admin/incidents', async (c) => {
  const { summary, description } = await c.req.json();
  const res = await fetch('https://uptime.betterstack.com/api/v3/incidents', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${c.env.BETTERSTACK_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ summary, description }),
  });
  return c.json(await res.json());
});
```

Creating an incident programmatically triggers on-call alerting automatically. Use this for anomalies your application detects that uptime monitors can't: agent loops, cost spikes, persistent Workflow failures after max retries.

**Status Page JSON API** — public, no authentication needed. Customers can poll it directly:

```typescript
// In any frontend app — no auth, no proxy needed
const status = await fetch('https://status.yourdomain.com/index.json');
const data = await status.json();
// Returns: resource statuses, uptime percentages, active incidents, historical data
```

Embed a status widget in your customer dashboard showing real-time platform health without exposing internal monitoring details.

**What this enables in your admin panel:**

| Widget | API | Data |
|--------|-----|------|
| Cost breakdown (CPU, LLM, DO) | SQL Query API | Structured logs with cost fields |
| Active incidents | Incidents API | Open incidents with status, cause, timestamps |
| Agent usage analytics | SQL Query API | Per-agent invocation counts, token usage, costs |
| Platform health | Status Page API | Uptime percentages, current status per service |
| Workflow success rate | SQL Query API | Completed vs failed Workflows over time |
| LLM provider health | SQL Query API | 429 rates, latency percentiles per provider |

### Cost

| Tool | Monthly Cost |
|------|-------------|
| Better Stack (paid plan) | ~$29 |
| Cloudflare Workers Observability | $0 (included in Workers Paid plan) |
| Cloudflare Tracing | $0 (free during beta, then billed as log events) |
| **Total** | **~$29/month** |

---

## 8. Fly.io Extension Path

When a workload needs sustained CPU beyond what Workers efficiently handles, extract it to Fly.io.

### When to Migrate a Workload

Migrate if the task:
- Uses >5 seconds of continuous CPU time (not I/O wait) per invocation
- Requires native binaries (FFmpeg, Pandoc, ML models)
- Needs more than 128MB of memory
- Benefits from persistent local filesystems
- Requires GPU access

Do **not** migrate if the task is mostly waiting on LLM API calls, database queries, or other I/O. Those stay on Workers.

### How the Bridge Works

When Fly.io is needed, add Cloudflare Queues as the bridge. This is the point where Queues enter the architecture (see Section 11). The Hono API publishes to a Queue instead of (or in addition to) triggering a Workflow directly. Fly.io services consume from the Queue via HTTP pull:

```
Hono API → env.AGENT_TASKS.send(task)
                    │
                    ▼
         Cloudflare Queue "agent-tasks"
            (configure as HTTP pull)
                    │
                    ▼
         Fly.io Rust service polls:
           GET https://api.cloudflare.com/client/v4/queues/{id}/messages/pull
                    │
                    ▼
         Process task, then acknowledge:
           POST https://api.cloudflare.com/client/v4/queues/{id}/messages/ack
                    │
                    ▼
         Fly.io calls Durable Object directly via HTTP
         to push result + status update to client
```

### Terraform Extension

```hcl
# infra/modules/flyio/main.tf
terraform {
  required_providers {
    fly = {
      source  = "fly-apps/fly"
      version = "~> 0.1"
    }
  }
}

resource "fly_app" "cpu_workers" {
  name = "aicaas-cpu-workers-${var.environment}"
  org  = var.fly_org
}

resource "fly_machine" "worker" {
  app    = fly_app.cpu_workers.name
  region = "iad"  # Start single-region, expand as needed
  image  = "registry.fly.io/aicaas-cpu-workers:latest"

  cpus     = 2
  memory   = 512     # MB
  cpu_kind = "shared" # $0.0035/hr — cheapest option

  env = {
    CLOUDFLARE_QUEUE_URL      = var.cloudflare_queue_pull_url  # Added when Queues are introduced
    CLOUDFLARE_API_TOKEN      = var.cloudflare_api_token
    NEON_DATABASE_URL         = var.neon_connection_string
  }
}
```

---

## 9. Glossary

| Term | Meaning |
|------|---------|
| **Worker** | A JavaScript/TypeScript function that runs on Cloudflare's edge network. Executes inside a V8 isolate (same engine as Chrome), not a container. Cold starts are sub-millisecond. |
| **Binding** | How a Worker accesses Cloudflare resources. Configured in `wrangler.jsonc`, available as typed properties on `env`. Like dependency injection at the platform level. |
| **V8 Isolate** | A lightweight sandbox within the V8 JavaScript engine. Hundreds of isolates share a single process, each with isolated memory. Much faster to start than a container or VM. |
| **workerd** | Cloudflare's open-source JavaScript runtime. Used both in production and local development (via Wrangler). Ensures dev/prod parity. |
| **Durable Object** | A stateful Worker with a unique ID, private storage (SQLite), and guaranteed single-threaded execution. The actor model on the edge. |
| **Vite** | A build tool and dev server. Provides Hot Module Replacement (edit a file → change appears in browser instantly without losing state). The standard build tool for everything except Next.js. |
| **SSR** | Server-Side Rendering. The server produces HTML and sends it to the browser, which then "hydrates" it (attaches event handlers to make it interactive). Faster initial page load than a purely client-rendered SPA. |
| **Loader / Action** | React Router v7 patterns. A Loader runs on the server before rendering (GET). An Action handles mutations (POST). They map cleanly to HTTP request/response. |
| **Service Binding** | Zero-latency Worker-to-Worker communication. The calling Worker invokes the target Worker directly, without going through the public internet. No additional request costs. |
| **Turborepo** | A monorepo build tool that runs on top of pnpm workspaces. Handles build ordering (shared packages before apps), parallel execution, and caching. When a package hasn't changed, downstream apps skip rebuilding it. |
| **Better Stack** | Observability platform combining logs, uptime monitoring, on-call alerting, and status pages in one product. Uses standard SQL for log queries. Receives Workers logs via Cloudflare Logpush. Exposes three APIs for embedding in your own app: SQL Query API (ClickHouse over HTTP for logs/metrics), Incidents API (REST for creating/listing/resolving incidents), Status Page JSON API (public, no auth). |
| **pnpm Workspaces** | pnpm's built-in monorepo support. A `pnpm-workspace.yaml` declares which directories contain packages. Apps can import from shared packages using `@scope/package-name`. One `pnpm install` at the root resolves all dependencies. |
| **Workflow** | A durable, multi-step execution engine. Each step is persisted, so if the Worker crashes mid-execution, the Workflow resumes from the last completed step. Billed on CPU time only — sleeping and waiting are free. |
| **Claim Check Pattern** | Store large data in R2 or Postgres, pass only a reference (ID or key) between Workflow steps. Avoids hitting Workflow state serialization limits when passing 100K+ token contexts or binary data between steps. |
| **MSW** | Mock Service Worker. Intercepts HTTP requests at the network level using the Service Worker API (browser) or class extension (Node.js). Application code runs unchanged — it just receives mock responses. Same handlers work in browser dev, Storybook, and Vitest. |
| **Storybook** | Frontend workshop for building UI components in isolation. Renders components without running the full application. Combined with MSW, each story can define its own API responses and test specific UI states (loading, error, empty, populated). |
| **Hyperdrive** | Cloudflare's connection pooling and acceleration service for external databases. Maintains a global pool of warm database connections so Workers don't pay the cost of establishing a new connection on every request. Caches cacheable query results (60s default TTL) — queries using STABLE functions like `NOW()` are not cached. Accessed via a binding that provides a standard Postgres connection string. |
| **Neon** | Serverless Postgres. Full Postgres with extensions (pgvector, etc.), branching for dev/test, and scale-to-zero. The database lives outside Cloudflare; Hyperdrive bridges the connection. |
| **KV** | Key-Value store optimized for high-read, low-write workloads. Eventually consistent (~60s propagation). Good for caches, config, session tokens. |
| **R2** | Object storage, S3-compatible API. No egress fees. For files, blobs, large payloads. |
| **AI Gateway** | Cloudflare's managed proxy for LLM API calls. Provides logging, analytics, caching, rate limiting, retries, and model fallback. One-line URL change to enable — no code changes to request format. |
| **SurrealDB** | Multi-model database combining relational, graph, vector, document, and real-time capabilities in one engine. Queried with SurrealQL (SQL-like). Used as the knowledge and memory layer for agents — graph traversal + vector search + permissions in one query. Connected from Workers via HTTP REST API. |
| **SurrealQL** | SurrealDB's query language. SQL-like syntax that supports relational queries, graph traversal (`->` and `<-` operators), vector search, and document operations in a single statement. Lower learning curve than Cypher (Neo4j's graph language). |
| **GraphRAG** | Retrieval-Augmented Generation enhanced with graph data. Combines vector similarity search (find relevant text chunks) with graph traversal (follow relationships for richer context). Produces more accurate and explainable LLM outputs than vector-only RAG. |
| **Queue** | Managed message queue (Cloudflare Queues). Not used in the starting architecture. Added when Fly.io bridge, webhook buffering, or cross-agent pub/sub is needed. Producers send via binding, consumers receive as push (Worker) or pull (HTTP from any runtime). |
| **HMR** | Hot Module Replacement. Edit a source file, and only the changed module is swapped in the running browser without a full page reload. State is preserved. |
| **IaC** | Infrastructure as Code. Define infrastructure (databases, queues, DNS) in version-controlled config files instead of clicking through dashboards. Terraform applies changes declaratively: you describe what you want, it figures out how to get there. |
| **HCL** | HashiCorp Configuration Language. Terraform's domain-specific language for defining infrastructure. Declarative, not imperative — you describe the desired state, not the steps to get there. |

---

## 10. Cost Estimate (Starting Point)

Estimates assume low traffic (< 100K requests/month), minimal R2 storage (< 1GB), and a single developer. LLM API costs are excluded — they depend entirely on usage and are tracked via Better Stack cost monitoring (Section 7).

**Development / pre-production:**

| Resource | Monthly Cost | What's included | What's excluded |
|----------|-------------|-----------------|-----------------|
| Workers Paid Plan | $5 | 10M requests, 30M CPU-ms, Hyperdrive, AI Gateway | Overages billed per-use |
| Neon Postgres | $0 (free tier) | 0.5GB storage, 190 compute hours | Scale-to-zero means cold starts (irrelevant during dev) |
| R2 | ~$0 | 10GB storage, 1M Class A ops, 10M Class B ops/month free | Class A (writes) and Class B (reads) ops charged beyond free tier |
| Durable Objects | ~$1-5 | Compute: $12.50/million requests. Storage: $0.20/GB/month | SQLite storage billing applies (enabled Jan 2026) |
| Better Stack | ~$29 | Logs, uptime, alerting, on-call, status page (per responder) | Telemetry API access is free |
| **Total** | **~$35-39/month** | | |

**Production (going live with real users):**

| Resource | Monthly Cost | Change from dev |
|----------|-------------|-----------------|
| Workers Paid Plan | $5 | Same |
| Neon Postgres | ~$19 | Paid plan with minimum compute (0.25 vCPU) to avoid cold starts. See Section 12 |
| R2 | ~$0-2 | May increase with file uploads and agent outputs |
| Durable Objects | ~$2-10 | More active sessions, more storage |
| Better Stack | ~$29 | Same |
| **Total** | **~$55-65/month** | With warm database for consistent latency |

Fly.io extension (when needed): shared-cpu-1x machine starts at $0.0035/hr (~$2.52/month always-on). KV, Queues, and additional Durable Object classes (rate limiters) add when their trigger conditions are met. AI Gateway is included in the Workers Paid plan.

---

## 11. When to Introduce Cloudflare Queues

The starting architecture has no message queues. Workflows provide durability, Durable Objects provide real-time updates and rate limiting. Queues are a future addition for specific problems that these primitives don't solve.

### Trigger: Fly.io Bridge

**When:** A workload moves to Fly.io because it needs sustained CPU, native binaries, or GPU access.

**Why Queues:** Fly.io services can't receive Cloudflare Workflow triggers or Durable Object calls — those are internal to Cloudflare's network. Queues support HTTP pull-based consumers, which any external service can poll. This is the only protocol-level bridge between Cloudflare and external compute.

**Change:** Hono publishes to a Queue (`env.AGENT_TASKS.send()`) instead of (or alongside) creating a Workflow directly. Fly.io Rust service pulls tasks via HTTP. Results go back to a Durable Object via a direct HTTP call to the Worker that fronts it.

### Trigger: Webhook Ingestion Spikes

**When:** External systems (CRM, Slack, email integrations) fire webhooks into your platform in bursts — someone imports 500 contacts, or Slack sends 200 message events during a meeting.

**Why Queues:** Each webhook could trigger agent analysis. Without a queue, 500 simultaneous webhook calls create 500 Workflow instances, all making LLM calls, blowing through rate limits immediately. The webhook endpoint needs to respond 200 quickly (Slack retries on slow responses), but processing should happen at a controlled pace.

**Change:** Webhook endpoints enqueue messages instead of triggering Workflows directly. A consumer Worker pulls batches and creates Workflow instances at a controlled rate.

### Trigger: Multi-Agent Fan-Out with Visibility

**When:** A single user request fans out to 5-10 specialized agent teams (PULSE, MINT, HIST) working in parallel, and you need to monitor backlog, prioritize teams, and inspect failures.

**Why Queues:** You can spawn child Workflows directly, but Queues give you operational visibility: backlog depth per team, dead letter queues for permanently failed tasks, and the ability to prioritize one team's work over another. Queues also let you add new consumers (a logging pipeline, an analytics system) without modifying the producing code.

**Change:** Parent Workflow publishes one message per agent team to a queue. Each team has a consumer that creates the appropriate Workflow. Dead letter queues capture failures for debugging.

### Trigger: Cross-Agent Event Bus

**When:** Agents need to observe each other's output. The MINT team (memory) needs to see every agent's results to build observational memory. Adding a new observer shouldn't require changing producing agents.

**Why Queues:** This is the pub/sub pattern. Agents publish their outputs to a topic-style queue. Any interested consumer picks up the messages. Decouples producers from consumers entirely.

**Change:** Workflow completion steps publish to an events queue in addition to storing results in Postgres. Consumer Workers route events to interested parties.

### How to Add Queues

The migration is minimal. In your Hono endpoint, change one line:

```typescript
// Before (direct Workflow trigger)
const instance = await c.env.AGENT_WORKFLOW.create({ params: taskData });

// After (Queue-mediated)
await c.env.AGENT_TASKS.send(taskData);
```

Add a consumer Worker that reads from the Queue and creates Workflows:

```typescript
export default {
  async queue(batch: MessageBatch, env: Env) {
    for (const message of batch.messages) {
      await env.AGENT_WORKFLOW.create({ params: message.body });
      message.ack();
    }
  },
};
```

Add queue resources to Terraform, add the consumer to your project layout, and deploy. No changes to Workflows, Durable Objects, or the UI.

---

## 12. Known Constraints and Mitigations

These are real limits you'll hit as the platform grows. None are blockers, but each requires a deliberate pattern to handle. Knowing them upfront avoids surprises in production.

### Durable Objects: Event Loop Blocking

Durable Objects are single-threaded. If an Agent Session DO handles 50 active WebSocket connections and you run a CPU-heavy task inside it — parsing a large LLM JSON response, heavy regex on streaming text — the event loop blocks. WebSocket pings drop, clients disconnect.

**Mitigation:** Treat the DO as a lightweight traffic cop and state manager. Offload all heavy parsing, prompt assembly, and JSON manipulation to Hono or Workflow steps. The DO should only receive pre-parsed, ready-to-broadcast status updates. The Workflow example in Section 4.6 already follows this pattern — the Workflow does the work, the DO just broadcasts.

### Durable Objects: Storage Discipline

DO SQLite storage is fast but not free at scale. Writing full LLM conversation histories or heavy RAG context windows directly into DO storage inflates costs and can hit transaction size limits.

**Mitigation:** Keep only "hot" state in the DO: current step, active status, connected client list, small UI state. Write "cold" state (full message history, raw documents, complete agent outputs) to Neon Postgres or R2 asynchronously. The DO holds what the WebSocket clients need right now; everything else lives in durable storage.

### Workflows: Idempotency, State Payload Limits, and Claim Check Pattern

**Idempotency:** Steps may retry after failure. Any side effects — database writes, notifications, external API calls — could execute more than once. Use idempotency keys: `INSERT ... ON CONFLICT DO NOTHING`, check for existing records before creating, or use unique request IDs for external calls. LLM calls are naturally idempotent (you get a different response, which is fine for most agent patterns).

**State payload limits:** Workflows persist state between steps automatically. If you pass large payloads — a 100K-token conversation history, base64-encoded images — as the return value of one step to the next, you risk hitting the 1 MiB per-step serialization limit.

**Mitigation: Claim Check Pattern.** Save large payloads to R2 or Postgres inside Step 1, return only the reference (file ID or record ID) to Step 2. Step 2 retrieves the full payload from storage.

```typescript
// Step 1: Save large context to R2, return a reference
const contextKey = await step.do('prepare-context', async () => {
  const context = await buildLargeContext(agentId);    // Could be 100KB+
  const key = `context/${agentId}/${Date.now()}.json`;
  await this.env.STORAGE.put(key, JSON.stringify(context));
  return key;  // Pass only the reference, not the payload
});

// Step 2: Retrieve context by reference
const response = await step.do('call-llm', async () => {
  const context = await this.env.STORAGE.get(contextKey);
  const parsed = JSON.parse(await context.text());
  return await callLLM(parsed);
});
```

### Workflows: Zombie Prevention

If a Workflow step calls an LLM API that hangs indefinitely without returning a clean error, the step stalls — consuming execution time or blocking the retry loop.

**Mitigation:** Wrap external `fetch` calls with `AbortController` timeouts. Configure maximum retry limits on Workflow steps. On final failure, write a "failed" status to the Durable Object so the UI doesn't spin forever.

```typescript
const response = await step.do('call-llm', {
  retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
}, async () => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);  // 30s hard timeout

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      signal: controller.signal,
      method: 'POST',
      headers: { ... },
      body: JSON.stringify({ ... }),
    });
    if (!res.ok) throw new Error(`LLM error: ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
});
```

### Authorization: Shared Logic Between Workers

React Router v7 loaders do direct CRUD to Postgres. The Hono API handles orchestration. This creates a risk of duplicating authorization logic. You verify "Does User A own Agent B?" in the UI loader but forget to enforce it in the Hono endpoint that triggers the Workflow.

**Hard rule:** All writes and any permission-sensitive reads must go through shared authorization logic. Direct route-level SQL is only acceptable for trivial, already-authorized reads (e.g., reading data that belongs to the authenticated user with no cross-tenant risk).

**Mitigation (pick one):**

- **Row Level Security (RLS) in Neon:** Push authorization to the database layer. Set the Postgres role context based on the incoming request before executing queries. Both React Router and Hono are subject to the same rules regardless of code path.
- **Shared auth package:** Create `@aicaas/auth` in your monorepo that exports a single `verifyAccess(userId, resourceId, db)` function used by both Workers.

RLS is more robust (can't be accidentally bypassed in application code) but harder to debug. The shared package is simpler to start with and can be replaced by RLS later.

### Deployment: Service Binding Version Skew

The React Router Worker calls the Hono Worker via a Service Binding. If you deploy a breaking change to Hono's API payload before the frontend is updated (or vice versa), requests fail.

**Mitigation:**

- Never remove or mutate an existing Hono endpoint. Create a v2 endpoint or make new fields optional.
- Deploy the API Worker first, then the frontend Workers. The API should always be backward-compatible.
- For major changes, use Cloudflare Workers' gradual rollout to route a percentage of traffic to the new version.

### Neon: Cold Starts Behind Hyperdrive (Production Only)

**This is not a concern during development.** During dev, you're either using a local Postgres or a Neon branch that's actively in use — no cold starts.

**In production:** Neon scales to zero when idle. Hyperdrive maintains warm connection pools, but it can't spin up a sleeping Neon instance instantly. If your Neon compute goes to sleep (no queries for 5 minutes on free tier), the first request after wake-up stalls for 1-3 seconds. This causes a slow page load or a Workflow step timeout.

**Why it matters:** During early development and testing, you're constantly querying the database — it never sleeps. The cold start problem only appears when you go live with real users who have quiet periods (overnight, weekends). You won't see it until production.

**Mitigation options:**

| Option | Cost Impact | When |
|--------|-----------|------|
| **Do nothing** | $0 | Development and testing. Cold starts don't affect you. |
| **Neon auto-suspend timeout** | $0 | Increase the auto-suspend delay from 5 min to 30 min (free tier allows up to 5 min, paid tier configurable). Reduces frequency of cold starts but doesn't eliminate them. |
| **Minimum compute size** | +$15-20/month | Production. Set Neon's minimum compute to 0.25 vCPU (disable scale-to-zero). The database stays warm permanently. Consistent latency. |
| **Warm-up cron** | $0 | A Cloudflare Cron Trigger that pings the database every 4 minutes to prevent sleep. Hacky but free. |

**Recommendation:** Ignore cold starts during development. When going to production, set a minimum compute size on Neon. Factor the ~$19/month into your production budget (see Section 10).

---

## 13. Frontend Mocking Strategy

Iterate on UX/UI without running the backend or incurring LLM costs. Three mocking layers cover the three communication patterns in the architecture: HTTP (Hono API), WebSocket (Durable Object live updates), and SSE (LLM token streaming).

### Approach

Mock at the **Hono API boundary**, not deeper. From the browser's perspective, React Router loaders call the API Worker via Service Binding — that's just a fetch response. You don't need to mock Postgres, Durable Objects, or Workflows individually. You mock the responses the frontend actually sees.

Two tools for two workflow modes:

| Mode | Tools | Cost | When |
|------|-------|------|------|
| **Component development** | Storybook + MSW + mock clients | $0 | 80% of frontend time. Build/iterate on UI in isolation |
| **Integration testing** | Wrangler dev + Neon branch | Free tier compute | Verify full flows (login → create agent → run Workflow → see progress) |

### Three Mocking Layers

| Communication | Mock approach | Package |
|---------------|--------------|---------|
| HTTP (Hono API, loaders) | Network-level interception | MSW via `@aicaas/mocks` |
| WebSocket (DO live updates) | Interface-level mock with simulated events | `@aicaas/ws-client` mock export |
| SSE (LLM token streaming) | `ReadableStream` factory | `@aicaas/mocks` streams |

### MSW — HTTP Mocking

MSW (Mock Service Worker) intercepts fetch requests at the network level. Your application code runs exactly as production — it just receives mock responses. Same handlers work in the browser (local dev), Node.js (Vitest), and Storybook.

Integrates with React Router v7 via `entry.client.tsx` — start the worker before hydration and all client-side fetches are intercepted:

```typescript
// apps/dashboard/app/entry.client.tsx
import { startTransition, StrictMode } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';

async function enableMocking() {
  if (process.env.NODE_ENV !== 'development') return;
  const { worker } = await import('@aicaas/mocks/browser');
  return worker.start({ onUnhandledRequest: 'bypass' });
}

enableMocking().then(() => {
  startTransition(() => {
    hydrateRoot(document, <StrictMode><HydratedRouter /></StrictMode>);
  });
});
```

### WebSocket — Durable Object Live Updates

The `@aicaas/ws-client` package already defines the interface every frontend uses to connect to Agent Session Durable Objects. The mock version implements the same interface but lets you push events programmatically — no WebSocket server needed:

```typescript
// packages/ws-client/src/index.ts — real implementation
export interface AgentSessionClient {
  connect(sessionId: string): void;
  onStatus(callback: (status: WorkflowStatus) => void): void;
  disconnect(): void;
}

export function createAgentSessionClient(wsUrl: string): AgentSessionClient {
  const ws = new WebSocket(wsUrl);
  // ... real WebSocket connection to Durable Object
}

// packages/ws-client/src/mock.ts — mock implementation
export function createMockAgentSessionClient(): AgentSessionClient & {
  simulateStatus(status: WorkflowStatus): void;
} {
  let callback: ((status: WorkflowStatus) => void) | null = null;

  return {
    connect: () => {},
    onStatus: (cb) => { callback = cb; },
    disconnect: () => {},
    simulateStatus: (status) => { callback?.(status); },
  };
}
```

In Storybook, inject the mock client and simulate a Workflow progressing:

```typescript
const mockWs = createMockAgentSessionClient();

export const WorkflowInProgress: Story = {
  args: { wsClient: mockWs },
  play: async () => {
    await delay(500);
    mockWs.simulateStatus({ status: 'building-prompt', step: 1, totalSteps: 5 });
    await delay(1000);
    mockWs.simulateStatus({ status: 'thinking', step: 2, totalSteps: 5 });
    await delay(2000);
    mockWs.simulateStatus({ status: 'done', step: 5, totalSteps: 5 });
  },
};
```

Components don't care whether status updates come from a real Durable Object or a mock. They receive `WorkflowStatus` objects through the same interface.

### SSE — LLM Token Streaming

Mock the streaming response with a `ReadableStream` that yields tokens on a timer:

```typescript
// packages/mocks/src/streams/llm.ts
export function createMockTokenStream(text: string, delayMs = 30) {
  return new ReadableStream({
    async start(controller) {
      for (const word of text.split(' ')) {
        await new Promise(r => setTimeout(r, delayMs));
        controller.enqueue(
          `data: {"type":"content_block_delta","delta":{"text":"${word} "}}\n\n`
        );
      }
      controller.enqueue('data: {"type":"message_stop"}\n\n');
      controller.close();
    },
  });
}
```

Use in an MSW handler:

```typescript
// packages/mocks/src/handlers/streaming.ts
import { http, HttpResponse } from 'msw';
import { createMockTokenStream } from '../streams/llm';

export const streamingHandlers = [
  http.post('/api/agents/:id/chat', () => {
    return new HttpResponse(
      createMockTokenStream('This is a mock response from the agent.'),
      { headers: { 'Content-Type': 'text/event-stream' } }
    );
  }),
];
```

### Monorepo Layout

```
packages/
├── shared/              # Types, API client
├── ui-kit/              # Shared React components
├── ws-client/           # WebSocket client
│   ├── src/
│   │   ├── index.ts           # Real AgentSessionClient
│   │   └── mock.ts            # Mock client with simulateStatus()
│   └── package.json
└── mocks/               # MSW handlers + fixture factories
    ├── src/
    │   ├── handlers/
    │   │   ├── agents.ts            # Mock Hono /api/agents/* endpoints
    │   │   ├── workflows.ts         # Mock Workflow status responses
    │   │   └── streaming.ts         # Mock SSE for LLM streams
    │   ├── streams/
    │   │   └── llm.ts               # createMockTokenStream()
    │   ├── fixtures/
    │   │   ├── agents.ts            # createMockAgent(), createMockAgentList()
    │   │   ├── workflows.ts         # createMockWorkflowStatus()
    │   │   └── users.ts             # createMockUser()
    │   ├── browser.ts               # setupWorker(...allHandlers) for browser
    │   ├── server.ts                # setupServer(...allHandlers) for Vitest
    │   └── index.ts                 # Export all handlers and fixtures
    └── package.json                 # @aicaas/mocks
```

Every frontend app imports `@aicaas/mocks` in development mode. Storybook uses the same handlers. Vitest uses the same handlers. One source of truth for mock data across the entire monorepo.

### Storybook Integration

Storybook renders components in isolation with MSW providing HTTP mocks and the ws-client mock providing WebSocket events:

```typescript
// .storybook/preview.ts
import { initialize, mswLoader } from 'msw-storybook-addon';
import type { Preview } from '@storybook/react';

initialize({ onUnhandledRequest: 'bypass' });

const preview: Preview = {
  loaders: [mswLoader],
};
export default preview;
```

Each story can override handlers for specific states (error, loading, empty):

```typescript
import { http, HttpResponse } from 'msw';

export const ErrorState: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get('/api/agents', () => {
          return HttpResponse.json({ error: 'Internal Server Error' }, { status: 500 });
        }),
      ],
    },
  },
};
```

### When to Use Which

| Task | Tool | Why |
|------|------|-----|
| Build a new component | Storybook + fixtures | No backend needed, instant feedback |
| Build a page with API calls | Storybook + MSW handlers | Controlled responses, test all states |
| Test Workflow progress UI | Storybook + mock ws-client | Simulate step-by-step DO updates |
| Test streaming chat UI | Storybook + MSW + mock stream | Simulated token delivery |
| Verify full user flow | Wrangler dev + Neon branch | Real stack, real bindings |
| Automated UI testing | Vitest + MSW (same handlers) | CI pipeline, no backend |
| Visual regression testing | Storybook + Chromatic | Screenshot comparison across PRs |
