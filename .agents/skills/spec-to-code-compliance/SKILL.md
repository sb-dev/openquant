---
name: spec-to-code-compliance
description: Check implementation code against its specification, protocol, whitepaper, or design document. Trace each requirement to evidence, report contradictions and missing or partial enforcement, and find undocumented behavior.
---

# Specification to code compliance

This is a local portable entry point adapted from the pinned Trail of Bits plugin.
Attribution: Trail of Bits, https://github.com/trailofbits/skills.
This adapted entry and its upstream resources retain CC-BY-SA-4.0;
see the preserved licence in `.claude/third-party/trailofbits/skills/LICENSE`.
The complete plugin source is in `upstream/`.
Use this shared skill directly. A Claude slash command, Workflow tool, and named
plugin agent are not required.
Apply repository instructions and canonical specifications first.
For OpenQuant, distinguish target checkpoint requirements from implemented bootstrap behavior.
This is a development tool, not a deployed research-agent bundle.

## Load the full procedure

Read [the upstream workflow](upstream/workflows/spec-compliance.js), including every
schema, prompt, evidence rule, failure branch, and report instruction.
Read [the checker role](upstream/agents/spec-compliance-checker.md).
Read the [analysis format](upstream/skills/spec-to-code-compliance/resources/ANALYSIS_FORMAT.md)
and [domain notes](upstream/skills/spec-to-code-compliance/resources/DOMAIN_NOTES.md).
Use the [worked examples](upstream/skills/spec-to-code-compliance/resources/WORKED_EXAMPLE.md)
when a verdict is unclear, and the
[divergence rubric](upstream/skills/spec-to-code-compliance/resources/DIVERGENCE_RUBRIC.md)
when assigning severity.

The JavaScript file is a workflow specification for this portable entry point.
It depends on host functions such as `agent`, `parallel`, `pipeline`, and `phase`.
Do not run it with plain Node or claim those functions exist in another host.
Perform its stages below with the available tools.
The unchanged [upstream entry](upstream/skills/spec-to-code-compliance/SKILL.upstream.md)
describes the native plugin; its mandatory slash-command routing is replaced here.
Its measured routing results do not establish results for this port.

## Runtime mapping

Resolve `baseDir` in the checker role to this skill's absolute `upstream/` directory.
Map `Read`, `Write`, `Grep`, and `Glob` to available file and search tools.
Use the current model unless the user requests another available model.
Read each role's complete instructions and the relevant workflow prompt before using it.

If generic delegation is available and permitted, give each requirement its own
fresh agent context with the checker role and complete requirement prompt.
Use two other agents for the code and document refutation lenses.
Give each agent only its task, cited source paths, relevant records, and output path.
Do not depend on `spec-to-code-compliance:spec-compliance-checker` registration.
Preserve the upstream schemas as record contracts. Check every required field,
its type, enum values, and cited file existence before accepting each record.
Do not describe this manual record check as runtime schema enforcement.

If delegation is unavailable, use sequential role passes and write each analysis
before proceeding. Start each pass from source artifacts, not a remembered summary.
Record `execution_mode: sequential-role-passes` and state that refutation was not
independent. Keep resulting divergence candidates in `unverified`; do not describe
self-review as independent confirmation. If context is insufficient, record the
remaining requirements as `notChecked` rather than compressing their checks.

## Portable stages

1. Resolve `path`, optional `spec`, optional `limit`, and `outDir` from the request.
   Default `path` to `.` and `outDir` to `spec-compliance`. Without host budget
   telemetry, default `limit` to 10; clamp an explicit limit to 1 through 30.
   Rank mandatory, recommended, optional, then descriptive requirements as upstream does.
   Create the output directory and
   `requirements/`. Keep all generated artifacts outside the source inputs.
2. Discover documents and implementation paths with `DISCOVERY_SCHEMA`.
   Preserve document authority, unreadable documents, and explicit scope.
   Stop when no readable specification exists. Do not infer requirements from code.
3. Extract each document with `REQUIREMENTS_SCHEMA` and the full extraction prompt.
   Quote requirements verbatim. Split compound claims. Preserve requirement force.
   Combine records before applying the selection limit. Resolve ID collisions using
   the upstream stable suffix procedure. Preserve every deferred requirement.
4. Run the reverse-direction sweep with `UNDOCUMENTED_SCHEMA` and its full prompt.
   Record failures separately from an empty behavior list.
5. For each selected requirement, run the checker role and complete alignment prompt.
   Write `requirements/<ordinal>-<id>.md` using the upstream slug and numbering rules.
   Save a corresponding `ALIGNMENT_SCHEMA` JSON record. Read both files back.
   Inspect enforcement, callees, callers, and alternate paths. A name is not evidence.
   An `absent` verdict needs the actual searches and their results.
6. For every non-`implemented` verdict, apply both full refutation prompts from the
   workflow: one checks code, the other checks the document. Persist both
   `REFUTATION_SCHEMA` records and any failed attempt. Either refutation drops the
   candidate. Keep its reason in the report's considered-and-dropped list.
   Keep corrections and revised verdicts. Name a missing lens explicitly; report
   both missing lenses as unverified. Sequential self-review is also unverified.
7. Produce `REPORT.md` using the entire upstream report prompt and `REPORT_SCHEMA`.
   Include the alignment matrix, surviving candidates, undocumented behavior,
   document problems, considered-and-dropped claims, failed checks, unreadable
   documents, deferred requirements, and unverified candidates.
   Separate confirmed divergences from unverified candidates.
   Assign severity by consequence, with the cited rubric.
8. Persist the workflow's final summary fields in `summary.json`, plus execution
   mode and refutation-independence status. Never substitute a failed check with
   `implemented`. Never default a missing report path to an expected path.
   Read the report, analyses, and summary back before reporting completion.

For one requirement, use the same checker, evidence, artifact, and refutation rules
without document-wide fan-out. For a whole document, keep per-requirement records;
do not collapse the analysis into a narrative review.

## Provenance and limits

All original agents, workflow code, resources, metadata, and evaluation fixtures
remain under `upstream/` (original skill entries are named `SKILL.upstream.md` to avoid duplicate discovery). The repository's third-party Trail of Bits
licence applies. This wrapper ports orchestration; it does not preserve the native
runtime's schema enforcement or guarantee independent contexts in sequential mode.
Installation and fixture checks alone do not establish actual project compliance.
