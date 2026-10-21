import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root, paths, repositoryTree } from './repository.ts';

// Include this output on the first run before it exists.
const files = [...new Set([...paths(root),'REPOSITORY_TREE.txt'])].sort();
writeFileSync(resolve(root,'REPOSITORY_TREE.txt'),repositoryTree(files));
console.log('Generated REPOSITORY_TREE.txt');
