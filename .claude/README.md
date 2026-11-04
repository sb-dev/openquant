# Shared development skills

This checkout contains 28 standalone skills shared by Codex and Claude Code. It also enables two Trail of Bits plugins for Claude Code. They cover the 30 selections for OpenQuant development and maintenance.

`CLAUDE.md` imports the canonical coding-agent instructions. OQ-03 §3 and OQ-06 §6 keep these tools separate from the reviewed bundles supplied to deployed research agents.

## Installed selection

| Skills | Source revision |
| --- | --- |
| `astro` | [astrolicious/agent-skills](https://github.com/astrolicious/agent-skills/tree/cb4839f3794189ebf35c55d3ba5d3876dff7acf0) |
| `durable-objects`, `workers-best-practices`, `wrangler` | [cloudflare/skills](https://github.com/cloudflare/skills/tree/1f2cd0a19588e2c6197c91dd7c71729df1fb6156) |
| `otel-instrumentation`, `otel-semantic-conventions` | [dash0hq/agent-skills](https://github.com/dash0hq/agent-skills/tree/120c2a9f0bfd143ee9ccd911b95626ece33c37fe) |
| `docker-build-strategies`, `docker-project-foundations` | [docker/skills](https://github.com/docker/skills/tree/090ff3d39db5f8bc55d4e951c26218e7c95ea2d3) |
| `secret-serialization`, `security-review`, `skill-scanner` | [getsentry/skills](https://github.com/getsentry/skills/tree/0c464f411bdfb8d4c12314b36264d06cb2f60270) |
| `github-actions-efficiency`, `github-actions-hardening` | [github/awesome-copilot](https://github.com/github/awesome-copilot/tree/7e408815ddcb64889a3683799a85399331cfd4ef) |
| `terraform-style-guide`, `terraform-test` | [hashicorp/agent-skills](https://github.com/hashicorp/agent-skills/tree/5e30fa5c867ba6777c37e4206babfd08049c396f) |
| `hono` | [honojs/skills](https://github.com/honojs/skills/tree/e54ce51f6effaeb574ebd2629e89e086e14a2db3) |
| `node`, `typescript-magician` | [mcollina/skills](https://github.com/mcollina/skills/tree/c75d70dbfbe991d8cec42aeda0b64ff14fbb9ac7) |
| `ml4t-lookahead-bias`, `ml4t-point-in-time`, `ml4t-survivorship-bias`, `ml4t-transaction-costs` | [ml4t/skills](https://github.com/ml4t/skills/tree/691857537a0c8befc11dc2f2ad7a458b7c7e801c) |
| `rust-best-practices` | [morganlinton/BeautifulRust](https://github.com/morganlinton/BeautifulRust/tree/edd3e86087eda07983251056508fe3b8856d85d7) |
| `neon-postgres` | [neondatabase/agent-skills](https://github.com/neondatabase/agent-skills/tree/ae9babbf804e90bf42e9444ebbc9278dfcb105eb) |
| `fly` | [superfly/skills](https://github.com/superfly/skills/tree/ba182c9ba6ffa5b107d5f7c77e0a2c37eeef89d3) |
| `ink` | [thanhdongnguyen/ink-skill](https://github.com/thanhdongnguyen/ink-skill/tree/90705d29f186d4ca7c85f885675fd7dedeed6c81) |
| `property-based-testing`, `spec-to-code-compliance (plugin)`, `rust-review (plugin)` | [trailofbits/skills](https://github.com/trailofbits/skills/tree/470419e16f97e112d01fc32f4898aea1755015d9) |
| `turborepo` | [vercel/turborepo](https://github.com/vercel/turborepo/tree/d95ea894953e9262c6b930b9aeb3a493e7a41884) |

Standalone files live in `.agents/skills` for Codex discovery. Each `.claude/skills/<name>` is a relative symlink to `../../.agents/skills/<name>`. Both agents read the same files. `skills-lock.json` records upstream content hashes. `.claude/skill-sources.json` records source commits, installer versions, plugin versions, and the one local adaptation.

The ML4T packages use the `ml4t-` prefix. Their Python examples provide research guidance. Apply OpenQuant's canonical Rust and TypeScript architecture when implementing it.

## Open this checkout

The 28 standalone skills are shared by Codex and Claude Code after checkout. Git must preserve symlinks. On Windows, enable Developer Mode or use a checkout with symlink support. Install the two full plugins once on each development machine, from the repository root.

```bash
claude plugin marketplace add trailofbits/skills --scope project
claude plugin install spec-to-code-compliance@trailofbits --scope project
claude plugin install rust-review@trailofbits --scope project

pnpm dlx skills@1.7.6 list --agent codex
pnpm dlx skills@1.7.6 list --agent claude-code
claude plugin list
```

The full plugins include their named agents, workflows, scripts, and prompts. The verified versions were `spec-to-code-compliance` 2.0.2 and `rust-review` 1.1.2. The marketplace configuration follows upstream. A fresh install can receive a newer version.

Shared project settings enable these plugins after installation. Each developer must install them on their own machine. [Claude Code settings reference](https://code.claude.com/docs/en/settings-reference#enabledplugins)

## Maintenance

Update shared skill files in `.agents/skills`. When using the Skills installer, target `--agent codex claude-code` and use its default symlink mode. Update only the selected skill or plugin needed for the task. Review the resulting source changes and preserve its licence notices. Refresh `.claude/skill-sources.json` and reapply its documented adaptation when updating `security-review`.

After staging the intended files, regenerate the repository map and verify.

```bash
pnpm generate:tree
pnpm verify
```

Upstream licences and notices are preserved under `.claude/third-party`. Ink declares MIT in its README. Astro declares MIT in its skill metadata. Neither source provides a separate licence file at the recorded revision, so their declarations are preserved verbatim.

## Verification scope and upstream limits

The Skills CLI 1.7.6 lists the same 28 shared skills for Codex and Claude Code. All 28 relative symlinks resolve to their canonical directories. Installation was checked with Skills CLI 1.7.6 and Claude Code 2.1.318. The 270 standalone files were compared with the recorded upstream Git blobs. The sole difference is the documented public-example key replacement. Both native plugins were installed, listed as enabled at project scope, and passed the Claude plugin validator. The validator also reported directory-publication metadata gaps for per-plugin licence files and icons. The upstream repository licence is preserved in the third-party notices.

The repository checks cover file presence, generated metadata, credentials, symlinks, and first-party local links. Vendored skill Markdown keeps its upstream links and is excluded only from local-link validation. The checks permit only the matching relative Claude skill links to tracked canonical skill files inside this repository. Archive scans record each link once and inspect the shared files once. Regression tests cover link targets and the validation boundary.

`otel-instrumentation` contains 22 links to the unselected upstream `otel-collector` and `otel-ottl` skills, plus two invalid anchors. Read those cross-references in the source repository linked above. The invalid anchors are `rules/resources.md` → `rules/resolve-values.md#servicecriticality` and `rules/sdks/go.md` → `#activate-the-sdk`.

These checks verify installation and repository integration. Authenticated Codex or Claude model execution, platform deployment, and the future application's skill-assisted workflows were not exercised.
