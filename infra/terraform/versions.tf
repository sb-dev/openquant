# Terraform and the Cloudflare provider, pinned exactly (OQ-06 section 3). Move a pin forward in a reviewed change,
# after reading the provider's upgrade notes.
#
# The state backend is configured at init, never here: `terraform init -backend-config=<file>` with a file kept out
# of Git (infra/terraform/README.md). The S3 backend serves any S3-compatible store, an R2 bucket of the owner's
# account included.

terraform {
  required_version = "~> 1.17.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.28.1"
    }
  }

  backend "s3" {}
}
