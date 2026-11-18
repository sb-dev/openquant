# Every value comes from a variable (OQ-06 section 3: no placeholder identifier in deployable configuration). The
# infrastructure workflow supplies them per environment through TF_VAR_* variables from its protected environment;
# no .tfvars file is tracked. infra/environments/staging.json lists these names; scripts/infrastructure.ts checks that
# both lists agree.

variable "cloudflare_account_id" {
  description = "The Cloudflare account that owns the bucket, the queue and Hyperdrive."
  type        = string
  nullable    = false
}

variable "cloudflare_zone_id" {
  description = "The zone of the API host name that the Worker route serves."
  type        = string
  nullable    = false
}

variable "artefacts_bucket_name" {
  description = "The R2 bucket of content-addressed artefacts (the ARTEFACTS binding of the Worker)."
  type        = string
  nullable    = false
}

variable "artefacts_bucket_location" {
  description = "The location hint of the R2 bucket, or null for Cloudflare's choice."
  type        = string
  default     = null
}

variable "batch_queue_name" {
  description = "The one batch queue (the BATCH_QUEUE producer of the Worker; the batch host pulls it over HTTP)."
  type        = string
  nullable    = false
}

variable "hyperdrive_name" {
  description = "The Hyperdrive configuration in front of Neon (the HYPERDRIVE binding of the Worker)."
  type        = string
  nullable    = false
}

variable "database_host" {
  description = "The Neon host name of the application database."
  type        = string
  nullable    = false
}

variable "database_port" {
  description = "The Postgres port of the Neon host."
  type        = number
  nullable    = false
}

variable "database_name" {
  description = "The application database."
  type        = string
  nullable    = false
}

variable "database_user" {
  description = "The application role that the owner created in Neon (not the migration role)."
  type        = string
  nullable    = false
}

variable "database_password" {
  description = "The password of the application role. Secret: supplied as TF_VAR_database_password only."
  type        = string
  sensitive   = true
  nullable    = false
}

variable "worker_name" {
  description = "The name of the Worker script that Wrangler deploys for this environment."
  type        = string
  nullable    = false
}

variable "api_route_pattern" {
  description = "The route of the API host, such as <api host>/*."
  type        = string
  nullable    = false
}
