# Getting started

Clone the repository and use the Node version in `.node-version`.

```bash
git clone https://github.com/sb-dev/openquant.git
cd openquant
```

Run the bootstrap verification:

```bash
node scripts/verify.ts
```

No dependency installation or cloud credentials are required. The check verifies repository structure, spec metadata, local links, acceptance IDs, source hashes, workflow conventions, and regression cases. It does not start OpenQuant.

## Next implementation

Read the [roadmap](../product/roadmap.md), then follow [C1 — Reproducible core](../guides/c1-reproducible-core.md). The target is a real Rust fixture evaluation inspected in Ink and exercised from a clean installed package. `openquant demo` is not implemented yet.

Before changing files, read [CONTRIBUTING.md](../../CONTRIBUTING.md), [AGENTS.md](../../AGENTS.md), and the owning specification. Work on a branch. Run verification before committing and use the specified commit format. AI-authored commits require a verified model trailer.

## Maintainer setup

Remote repository settings are separate from the source checkout. Inspect existing settings before changing them. Require the stable `ci` check through a branch ruleset after that check exists.

Enable code-owner review and protect changes to workflows, specs, schemas, risk code, and infrastructure. Verify the ruleset settings. Keep fork PR workflows free from secrets and use a read-only default Actions token.

Enable and verify private vulnerability reporting before public release. Set a private maintainer contact for community concerns. The bootstrap does not configure these remote settings.

Deployment and release workflows are added with their implementation checkpoints. They need protected environments, scoped credentials, reviewed artefact identity, and read-back tests before use. No cloud deployment is needed to inspect or verify this bootstrap.

