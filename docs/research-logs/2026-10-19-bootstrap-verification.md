# Bootstrap verification

Date: 19 October 2026.

Scope: repository bootstrap. No application checkpoint or remote deployment is accepted by these results.

## Checks run

| Check | Observed result |
| --- | --- |
| `node scripts/verify.ts` | Repository checks and all 10 regression tests passed. |
| `pnpm verify` | The same checks and all 10 tests passed with pnpm 11.25.0. |
| Fresh Git index | Initialised a temporary repository, staged the bootstrap, and ran verification successfully. No commit was created. |
| Product acceptance | Compared every A01–A18 statement with Design v2; all 18 matched exactly. |
| Repository acceptance | Compared every R01–R10 statement with Repository Design v1.1; all 10 matched exactly. |
| GitHub YAML | Parsed workflow, Dependabot, and issue forms. Checked CI triggers, read-only permission, and aggregate dependency wiring. |
| Source provenance | All nine archived documents matched their original SHA-256 hashes. |
| Actions references | Read official tag refs and action definitions. Confirmed pinned commits and configured inputs. |

Node used: `v24.19.0`. TypeScript runs through native type stripping. No TypeScript compiler check is claimed.

Regression cases reject index drift, missing acceptance criteria, broken file/heading links, altered source bytes, file-map drift, mutable Action references, CI secret use, and source-manifest path escape.

## Pinned Actions

- `actions/checkout` `v7.0.1`: `3d3c42e5aac5ba805825da76410c181273ba90b1`.
- `actions/setup-node` `v7.1.0`: `949feb2413d6458794dcd2491c4babbbce0c15c1`.

Both commits were resolved through their official GitHub tag refs. Their action definitions use Node 24. The setup inputs `node-version-file` and `package-manager-cache`, and checkout's `persist-credentials`, were read from those pinned definitions.

## Not verified

No GitHub repository was created or changed. GitHub-hosted Actions, branch rules, environment protections, private reporting, and CODEOWNERS enforcement were not exercised.

There is no Ink application, Rust engine, API, model runner, broker adapter, or deployable cloud configuration to test. C1–C4 and runtime acceptance remain unimplemented. Static workflow checks are not a full security audit.
