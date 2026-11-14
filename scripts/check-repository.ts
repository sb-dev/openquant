import { checkRepository, root } from './repository.ts';

// The repository checks need no dependency install. CI runs this file as its own step before any install, and
// verify.ts runs it again as step 1. scripts/s0.ts compares this file, without comments and blank lines, with a
// literal copy of its code, and no top-level code here or in a module it imports may use process (OQ-06 section 2.2).
function report(errors: readonly string[]): void {
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
  else console.log('Repository checks passed: specs, acceptance IDs, links, source hashes, file map, agent assets, verification guards, and workflow conventions.');
}

report(checkRepository(root));
