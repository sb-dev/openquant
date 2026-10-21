# Infrastructure

No deployable infrastructure is included in the bootstrap. The owning contracts are [architecture](../docs/specs/05-system-architecture-and-data-spec.md) and [engineering](../docs/specs/06-engineering-delivery-and-operations-spec.md).

| Area | Owner |
| --- | --- |
| [Terraform](terraform/README.md) | Supported Cloudflare resources. |
| [Fly](fly/README.md) | Versioned native app profiles and controlled flyctl rollout. |
| [Environments](environments/README.md) | Non-secret names, bindings, capabilities, and release references. |

Add concrete resource identifiers only after provisioning and read-back. Do not place placeholder IDs in deployable configuration. GitHub Actions is the release controller; Cloudflare runs product scheduling and workflows.
