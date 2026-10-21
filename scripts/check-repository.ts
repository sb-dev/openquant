import { checkRepository, root } from './repository.ts';

const errors = checkRepository(root);
for (const error of errors) console.error(error);
if (errors.length) process.exitCode = 1;
else console.log('Repository checks passed: specs, acceptance IDs, links, source hashes, file map, and workflow conventions.');
