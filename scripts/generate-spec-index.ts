import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, specIndex } from './repository.ts';

writeFileSync(resolve(root,'docs/specs/README.md'),specIndex(root));
console.log('Generated docs/specs/README.md');
