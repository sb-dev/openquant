import { spawnSync } from 'node:child_process';
import { root } from './repository.ts';

for (const args of [['scripts/check-repository.ts'], ['--test','scripts/tests/repository.test.ts']]) {
  const result = spawnSync(process.execPath,args,{cwd:root,stdio:'inherit'});
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('Bootstrap verification passed. Application and deployment acceptance remain unimplemented.');
