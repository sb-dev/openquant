# Agent instructions

Read [docs/specs/README.md](docs/specs/README.md) and the owning specification before changing behaviour. Imported documents in `docs/research-logs/imported` are non-canonical historical inputs. This file governs coding agents, not deployed research agents.

## Scope and boundaries

- The current repository is a bootstrap. Do not claim C1–C4 are implemented.
- Keep the Kakeibo-style roots. Add executable packages only with working code and verification.
- Ink owns rendering/input and local presentation state. Hono is its only remote boundary.
- Cloudflare coordinates product work. Fly.io runs native compute and delegated execution.
- Keep four shared packages. API-only modules stay in `apps/api` until reuse requires extraction.
- Proposer and critic return proposals. Guarded application commands own accepted writes.
- Use one shared Rust core. Isolate live credentials, account authority, resources, and deployment.
- Keep the Strategy Graph derived. Do not require manual graph maintenance.
- Never enable live trading, change active mandates, or submit broker orders as a repository task.
- Do not copy credentials, private account data, or licensed datasets into Git or public artefacts.

## Verification

Run `pnpm verify`, or `node scripts/verify.ts` without pnpm. This runs the implemented bootstrap checks only.

After editing spec metadata, run `pnpm generate:spec-index`. Stage intended added/deleted paths before `pnpm generate:tree` in a Git checkout. Regenerate and verify again.

When implementing a checkpoint, add its required TypeScript, Rust, protocol, fixture, installed-package, and operational checks to `pnpm verify`. Do not substitute no-op commands or zero tests. Do not broaden the architecture to make a test easier.

Preserve A01–A18 and R01–R10. Update the owning specification for changed semantics. Explain changed expected numbers. Never regenerate golden results during a test.

## Commits and completion

Before committing, inspect the existing history and repository guidance. Use `<type>: <imperative summary>`, with `feature`, `fix`, `docs`, or `chore`. Explain what changed and why in short body paragraphs. Cite the owning specification where relevant.

Every AI-authored commit ends with exactly one `Co-Authored-By: <exact model name> <provider noreply address>` trailer. Verify the model identity; never infer it from a product label or guess. Do not add session links or generated advertisements.

Run required verification before committing. Report unavailable or failed checks. Read external changes back before reporting success. Distinguish implemented behaviour, reported source facts, and inference.
