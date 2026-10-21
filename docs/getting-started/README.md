# Start with the bootstrap

Extract the ZIP and open its `openquant` directory. Use Node 24.19.0 from `.node-version`.

```bash
node scripts/verify.ts
```

No dependency installation or cloud credentials are required. The check verifies repository structure, spec metadata, local links, acceptance IDs, source hashes, workflow conventions, and regression cases. It does not start OpenQuant.

## Import into GitHub

Create an empty repository and import the files, including `.github`. Before the first commit, read [CONTRIBUTING.md](../../CONTRIBUTING.md). Run verification and use the specified commit format. AI-authored commits require a verified model trailer.

Push the default branch as `main`. Read the resulting files and first Actions run back. Require the stable `ci` check through a branch ruleset after that check exists.

Enable code-owner review and protect changes to workflows, specs, schemas, risk code, and infrastructure. Verify the ruleset settings. Keep fork PR workflows free from secrets and use a read-only default Actions token.

Enable and verify private vulnerability reporting before public release. Set a private maintainer contact for community concerns. The bootstrap does not configure these remote settings.

Deployment and release workflows are added with their implementation checkpoints. They need protected environments, scoped credentials, reviewed artefact identity, and read-back tests before use. No cloud deployment is needed to inspect or verify this bootstrap.

## Next implementation

Follow [C1 — Reproducible core](../guides/c1-reproducible-core.md). The target is a real Rust fixture evaluation inspected in Ink and exercised from a clean installed package.
