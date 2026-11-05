# Shared development skills

This checkout contains 39 shared development skills for Codex and Claude Code. Files live in `.agents/skills`; matching relative links expose them to Claude Code. Two existing native Claude plugin settings remain unchanged.

`CLAUDE.md` imports the canonical coding-agent instructions. OQ-03 §3 and OQ-06 §6 keep these tools separate from the reviewed bundles supplied to deployed research agents.

## Installed selection

| Skills | Source revision |
| --- | --- |
| `astro` | [astrolicious/agent-skills](https://github.com/astrolicious/agent-skills/tree/cb4839f3794189ebf35c55d3ba5d3876dff7acf0) |
| `durable-objects`, `workers-best-practices`, `wrangler` | [cloudflare/skills](https://github.com/cloudflare/skills/tree/1f2cd0a19588e2c6197c91dd7c71729df1fb6156) |
| `otel-instrumentation`, `otel-semantic-conventions` | [dash0hq/agent-skills](https://github.com/dash0hq/agent-skills/tree/120c2a9f0bfd143ee9ccd911b95626ece33c37fe) |
| `docker-build-strategies`, `docker-project-foundations` | [docker/skills](https://github.com/docker/skills/tree/090ff3d39db5f8bc55d4e951c26218e7c95ea2d3) |
| `gha-security-review`, `secret-serialization`, `security-review`, `skill-scanner` | [getsentry/skills](https://github.com/getsentry/skills/tree/0c464f411bdfb8d4c12314b36264d06cb2f60270) |
| `github-actions-efficiency`, `github-actions-hardening` | [github/awesome-copilot](https://github.com/github/awesome-copilot/tree/7e408815ddcb64889a3683799a85399331cfd4ef) |
| `terraform-style-guide`, `terraform-test` | [hashicorp/agent-skills](https://github.com/hashicorp/agent-skills/tree/5e30fa5c867ba6777c37e4206babfd08049c396f) |
| `hono` | [honojs/skills](https://github.com/honojs/skills/tree/e54ce51f6effaeb574ebd2629e89e086e14a2db3) |
| `node`, `typescript-magician` | [mcollina/skills](https://github.com/mcollina/skills/tree/c75d70dbfbe991d8cec42aeda0b64ff14fbb9ac7) |
| `ml4t-lookahead-bias`, `ml4t-point-in-time`, `ml4t-survivorship-bias`, `ml4t-transaction-costs` | [ml4t/skills](https://github.com/ml4t/skills/tree/691857537a0c8befc11dc2f2ad7a458b7c7e801c) |
| `rust-best-practices` | [morganlinton/BeautifulRust](https://github.com/morganlinton/BeautifulRust/tree/edd3e86087eda07983251056508fe3b8856d85d7) |
| `neon-postgres` | [neondatabase/agent-skills](https://github.com/neondatabase/agent-skills/tree/ae9babbf804e90bf42e9444ebbc9278dfcb105eb) |
| `fly` | [superfly/skills](https://github.com/superfly/skills/tree/ba182c9ba6ffa5b107d5f7c77e0a2c37eeef89d3) |
| `ink` | [thanhdongnguyen/ink-skill](https://github.com/thanhdongnguyen/ink-skill/tree/90705d29f186d4ca7c85f885675fd7dedeed6c81) |
| `property-based-testing`, `spec-to-code-compliance` (portable entry), `rust-review` (portable entry) | [trailofbits/skills](https://github.com/trailofbits/skills/tree/470419e16f97e112d01fc32f4898aea1755015d9) |
| `turborepo` | [vercel/turborepo](https://github.com/vercel/turborepo/tree/d95ea894953e9262c6b930b9aeb3a493e7a41884) |
| `llm-evaluation`, `prompt-engineering-patterns` | [wshobson/agents](https://github.com/wshobson/agents/tree/7e2fb559cf4b824b27f1fec49fe88f7511066d26) |

Standalone files live in `.agents/skills` for Codex discovery. Each `.claude/skills/<name>` is a relative symlink to `../../.agents/skills/<name>`. Both agents read the same files. `skills-lock.json` records upstream content hashes. `.claude/skill-sources.json` records source commits, installer versions, plugin versions, and local adaptations. `.claude/portable-skill-sources.json` records every file and hash in the two portable review bundles. First-party skills and portable entries are maintained here; they are not upstream Skills CLI installs.

The ML4T packages use the `ml4t-` prefix. Their Python examples provide research guidance. Apply OpenQuant's canonical Rust and TypeScript architecture when implementing it.

## Task coverage

| Task | Skill | Owning specification |
| --- | --- | --- |
| Ordinary coding, tests, dependencies, configuration, and review | `pragmatic-developer` | OQ-06 §6 |
| AgentExecutor, proposer/critic prompts, context, permissions, model evaluation | `openquant-ai-engineering`, `prompt-engineering-patterns`, `llm-evaluation` | OQ-03 §§1–6 |
| Research/evaluation orchestration, schedules, outbox, claims, retries, cancellation | `openquant-workflow-design` | OQ-05 §§3–5; OQ-03 §5 |
| Competing stock research, sources, cohorts, holdouts, forecast calibration | `openquant-research-evaluation` plus the four ML4T skills | OQ-01 §§2–3; OQ-02 §3; OQ-03 §§1–2 |
| Financial fixtures, units, accounting, risk, numerical regressions | `openquant-financial-invariants`, `property-based-testing`, `rust-review` | OQ-02 §§2–3, 6–9 |
| Complete vertical slices and requirement-to-test traceability | `openquant-vertical-slice`, `spec-to-code-compliance` | OQ-06 §8 |
| Workflow exploitation and CI trust boundaries | `gha-security-review` plus the existing GitHub Actions skills | OQ-06 §2 |

`pragmatic-developer` is the user-supplied existing simplified skill dated 2026-09-25, copied without changes. Its original Karpathy Guidelines attribution is preserved. It is a local skill, not a new upstream package. Its source filename and SHA-256 are recorded in `.claude/skill-sources.json`.

The five `openquant-` skills are first-party development procedures derived from the canonical specifications. They do not implement product capabilities or change the roadmap. Watchlist contracts that are not yet specified must be defined in their owning specification before implementation.

## Open this checkout

The 39 shared skills are present after checkout. Git must preserve symlinks. On Windows, enable Developer Mode or use a checkout with symlink support.

```bash
pnpm dlx skills@1.7.6 list --agent codex
pnpm dlx skills@1.7.6 list --agent claude-code
```

Invoke `rust-review` or `spec-to-code-compliance` as shared skills. Each has a portable entry point and the complete pinned upstream plugin resources. Native plugin-specific tool names are mapped to available host capabilities. Sequential role passes are labelled as non-independent; they cannot establish independent validation. Native workflow JavaScript is a procedure reference and must not be run as plain Node code.

Original nested skill entry files are named `SKILL.upstream.md` to prevent duplicate discovery. The Rust regex test has one corresponding path adaptation. Other upstream file contents remain unchanged. Python 3.11+ and `uv` are required for the Rust review helpers.

The existing Claude plugin settings are retained. The native plugin variants are optional alternatives to the shared entries and need machine-local installation:

```bash
claude plugin marketplace add trailofbits/skills --scope project
claude plugin install spec-to-code-compliance@trailofbits --scope project
claude plugin install rust-review@trailofbits --scope project
```

Do not run both variants for the same task. A new native plugin install can receive a newer upstream version. The pinned shared resources remain reproducible in this checkout.

## Maintenance

Update shared skill files in `.agents/skills`. When using the Skills installer, target `--agent codex claude-code` and use its default symlink mode. Update only the selected skill or plugin needed for the task. Review the resulting source changes and preserve its licence notices. Refresh `.claude/skill-sources.json` and reapply its documented adaptation when updating `security-review`.

After staging the intended files, regenerate the repository map and verify.

```bash
pnpm generate:tree
pnpm verify
```

Upstream licences and notices are preserved under `.claude/third-party`. Ink declares MIT in its README. Astro declares MIT in its skill metadata. Neither source provides a separate licence file at the recorded revision, so their declarations are preserved verbatim.

## Verification scope and upstream limits

`pnpm verify` checks the declared shared inventory, matching aliases, installer records, portable support files and hashes, repository integrity, and mutation tests. The inventory includes the first-party and portable skills that are intentionally absent from the upstream installer lockfile. A plugin setting alone cannot satisfy a declared shared skill.

The portable Rust bundle includes upstream helper tests. These test the helpers, not OpenQuant's future Rust engine. There is currently no product Rust source to audit. A limited compliance exercise can classify planned runtime requirements as absent without claiming a bootstrap defect or whole-project compliance.

The two generic AI skills preserve their full upstream files and MIT notice. Their Python examples, placeholder metric functions, model names, and optional framework integrations are illustrative. They are not verified OpenQuant invocation recipes. The prompt optimizer uses word counts as estimated tokens and word overlap as accuracy. Use the OpenQuant AI skill for authoritative evaluation and architecture constraints; do not add LangChain, model routing, or a vector database merely to use an example.

The Sentry GHA skill has a narrower external-attacker threat model than OpenQuant's complete CI contract. OpenQuant still requires every remote Action, including `actions/*`, to use a full commit SHA.

Vendored Markdown retains upstream links. `otel-instrumentation` still contains links to unselected `otel-collector` and `otel-ottl` skills and two invalid anchors noted in the original installation. Consult the pinned source for those references.

Installation, static checks, helper tests, and bounded skill exercises do not establish production model behaviour, deployment readiness, or C1–C4 acceptance. See the [addition record](../docs/research-logs/2026-11-04-development-skill-completion.md) for checks and limits.
