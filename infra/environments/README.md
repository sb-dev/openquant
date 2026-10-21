# Environment profiles

Use development, staging, and production profiles. A production API does not enable live trading.

Profiles will contain non-secret app names, regions, bindings, capabilities, schema/migration requirements, and immutable release references. Credentials belong in their scoped secret stores.

Missing required configuration must fail validation. Do not substitute placeholder IDs. Test environment protections and deployed identity before claiming a deployment works.
