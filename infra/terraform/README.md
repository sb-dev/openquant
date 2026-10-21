# Terraform ownership

At C2, manage supported Cloudflare storage, cache-disabled Hyperdrive, batch queue, routes/DNS, and access resources. Use versioned setup commands for the HTTP-pull consumer where required.

Keep state, plans, and secrets out of Git. Wrangler owns Worker code and bindings. flyctl owns Fly app deployment. Do not assign the same resource to two tools.
