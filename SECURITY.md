# Security

This bootstrap has no deployed service or live-trading support. No version is currently declared production-supported.

## Report privately

Do not open a public issue containing credentials, private account data, exploitable broker/risk bypass details, authentication bypass, executor escape, or supply-chain compromise.

After repository import, the maintainer must enable and verify GitHub private vulnerability reporting. Use the repository's **Security → Report a vulnerability** route only when it is available. This bootstrap has not configured or verified that route.

If the route is absent, ask the maintainer for a private reporting channel without publishing exploit details. A verified private channel is a public-release gate.

Reports should include affected version, safe reproduction, impact, and redacted evidence. Do not test against live accounts or third-party systems without permission.

## Required controls

The [engineering spec](docs/specs/06-engineering-delivery-and-operations-spec.md) owns CI and deployment controls. The [domain spec](docs/specs/02-trading-domain-and-evaluation-spec.md) owns trading safety. Local pattern checks are not a full security audit or proof that external repository controls are enabled.
