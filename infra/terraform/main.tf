# The Cloudflare resources that Terraform owns (OQ-06 section 3): the artefact bucket, the batch queue, Hyperdrive with
# caching disabled, and the Worker route. Wrangler owns the Worker code and its bindings; the HTTP-pull consumer of the
# queue is a versioned setup command of the infrastructure workflow, not a resource here. One writer per resource.
#
# The provider reads its credential from CLOUDFLARE_API_TOKEN in the environment of the protected job; nothing here
# names it.

provider "cloudflare" {}

resource "cloudflare_r2_bucket" "artefacts" {
  account_id = var.cloudflare_account_id
  name       = var.artefacts_bucket_name
  location   = var.artefacts_bucket_location
}

resource "cloudflare_queue" "batch" {
  account_id = var.cloudflare_account_id
  queue_name = var.batch_queue_name
}

# Private application state is never read from a cache (OQ-05 section 5): caching is disabled on the resource itself.
resource "cloudflare_hyperdrive_config" "application" {
  account_id = var.cloudflare_account_id
  name       = var.hyperdrive_name

  origin = {
    scheme   = "postgres"
    host     = var.database_host
    port     = var.database_port
    database = var.database_name
    user     = var.database_user
    password = var.database_password
  }

  caching = {
    disabled = true
  }
}

resource "cloudflare_workers_route" "api" {
  zone_id = var.cloudflare_zone_id
  pattern = var.api_route_pattern
  script  = var.worker_name
}
