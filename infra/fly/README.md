# Fly.io profiles

Create profiles with working images and verification:

| File | Checkpoint | Required boundary |
| --- | --- | --- |
| `agent-runner.toml` | C2 | Separate app; isolated delegated CLI; no broker, repository-write, or deployment authority. |
| `engine-batch.toml` | C2 | Separate app; bounded native compute; HTTP-pull queue; attempt-scoped outcomes. |
| `engine-paper.toml` | C3 | Persistent live-data paper/shadow sessions; no broker trading credentials. |
| `engine-live.toml` | C4 | Isolated live app; one account writer; separately protected deploy and secrets. |

These files are not supplied as dummy configurations. Pin tested images and select a region from actual data/broker/database needs.

Do not use HTTP-idle autostop for paper/live sessions. Keep the batch consumer running unless a tested wake-up path exists. Root disks are scratch. A recovery journal is not a second canonical portfolio database.

Fly app secrets are app-wide. Process groups alone do not isolate broker credentials. Test old-writer shutdown, restart reconciliation, and read-back before any live resumption.
