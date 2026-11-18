# The identifiers that the Wrangler deployment needs for its bindings (OQ-06 section 3: generated binding metadata
# where Terraform outputs feed Wrangler). They are read back after apply; none is written into a tracked file.

output "artefacts_bucket_name" {
  description = "The bucket_name of the ARTEFACTS binding."
  value       = cloudflare_r2_bucket.artefacts.name
}

output "batch_queue_id" {
  description = "The queue id: OPENQUANT_QUEUE_ID of the batch host, and the queue of the BATCH_QUEUE producer."
  value       = cloudflare_queue.batch.id
}

output "batch_queue_name" {
  description = "The queue of the BATCH_QUEUE producer binding."
  value       = cloudflare_queue.batch.queue_name
}

output "hyperdrive_id" {
  description = "The id of the HYPERDRIVE binding."
  value       = cloudflare_hyperdrive_config.application.id
}
