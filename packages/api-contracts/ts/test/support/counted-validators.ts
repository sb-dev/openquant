// Copies of the generated validators that count their calls. With inlineRefs off, each function of
// the Ajv standalone code is one referenced definition, and each call applies it to one value, so
// the count measures validation work without a clock.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ContractName } from '../../dist/generated/contracts.ts';
import type { StandaloneValidator } from '../../dist/generated/validators-all.js';

const generated = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/generated');
const FUNCTION = /function validate\d+\(/g;
const ENTRY =
  /function validate\d+\(data, \{instancePath="", parentData, parentDataProperty, rootData=data, dynamicAnchors=\{\}\}=\{\}\)\{/g;

export interface CountedValidators {
  readonly byContract: Readonly<Record<ContractName, StandaloneValidator>>;
  /** Validator calls since the last reset. */
  calls(): number;
  reset(): void;
}

export async function countedValidators(mode: 'first' | 'all'): Promise<CountedValidators> {
  const source = readFileSync(join(generated, `validators-${mode}.js`), 'utf8');
  let entries = 0;
  const instrumented = source.replace(ENTRY, (entry) => {
    entries += 1;
    return `${entry}callCounter.calls += 1;`;
  });
  const functions = source.match(FUNCTION)?.length ?? 0;
  if (entries === 0 || entries !== functions) {
    throw new Error(`instrumented ${entries} of ${functions} validator functions; the generated code changed shape`);
  }
  const directory = mkdtempSync(join(tmpdir(), 'openquant-validators-'));
  try {
    const file = join(directory, `validators-${mode}.mjs`);
    writeFileSync(file, `export const callCounter = { calls: 0 };\n${instrumented}`);
    const module = (await import(pathToFileURL(file).href)) as {
      byContract: Readonly<Record<ContractName, StandaloneValidator>>;
      callCounter: { calls: number };
    };
    return {
      byContract: module.byContract,
      calls: () => module.callCounter.calls,
      reset: () => {
        module.callCounter.calls = 0;
      },
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
