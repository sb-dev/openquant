import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_NAME, RUNNER_VERSION } from '../src/main.ts';
import { runnerRoot } from './support/world.ts';

const source = (name: string) => readFileSync(join(runnerRoot, 'src', name), 'utf8');
const files = readdirSync(join(runnerRoot, 'src')).filter((name) => name.endsWith('.ts'));

// The module specifiers of static imports and re-exports, and of dynamic imports and require calls.
function importSpecifiers(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\bfrom\s*)?['"]([^'"\n]+)['"]/g))
    found.push(match[1] ?? '');
  for (const match of text.matchAll(/\b(?:import|require)\s*\(\s*['"`]([^'"`\n]+)['"`]\s*\)/g))
    found.push(match[1] ?? '');
  return found;
}

// Code without comments and without string contents is not needed here: the patterns below are specific enough, and a
// comment that names one of them is written to avoid it.

describe('the source of the runner', () => {
  it('has one place that reads the process environment: the entry point', () => {
    for (const name of files) {
      const reads = /process\.env/.test(source(name));
      expect(reads, name).toBe(name === 'main.ts');
    }
  });

  it('starts a process only through spawn with an argument list: no shell, no exec, no eval', () => {
    for (const name of files) {
      const text = source(name);
      expect(text, name).not.toMatch(/\b(?:execSync|execFile|execFileSync|spawnSync|fork)\s*\(/);
      expect(text, name).not.toMatch(/shell\s*:/);
      expect(text, name).not.toMatch(/\beval\s*\(|new Function\b/);
    }
    expect(files.filter((name) => /from 'node:child_process'/.test(source(name)))).toEqual(['process-tree.ts']);
    // The one import names only `spawn` and the type of its result, so `exec` and `execSync` cannot be reached.
    expect(source('process-tree.ts')).toContain("import { type ChildProcess, spawn } from 'node:child_process';");
  });

  it('imports only Node built-in modules, its two workspace packages and its own files', () => {
    for (const name of files) {
      for (const specifier of importSpecifiers(source(name))) {
        const allowed =
          specifier.startsWith('node:') ||
          specifier.startsWith('./') ||
          specifier === '@openquant/agents' ||
          specifier === '@openquant/api-contracts';
        expect(allowed, `${name} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('imports no broker, engine or API code', () => {
    for (const name of files) {
      for (const specifier of importSpecifiers(source(name))) {
        expect(specifier, name).not.toMatch(/apps\/(?:engine|api)|broker|alpaca|@openquant\/(?:engine|api)(?=\/|$)/i);
      }
    }
  });

  it('names its package and version as package.json does', () => {
    const manifest = JSON.parse(readFileSync(resolve(runnerRoot, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      scripts: Record<string, string>;
    };
    expect(manifest.name).toBe('@openquant/agent-runner');
    expect(RUNNER_VERSION).toBe(manifest.version);
    expect(RUNNER_NAME).toBe('openquant-agent-runner');
    expect(Object.keys(manifest.scripts).sort()).toEqual(['build', 'lint', 'start', 'test', 'typecheck']);
  });

  it('declares no dependency but its two workspace packages', () => {
    const manifest = JSON.parse(readFileSync(resolve(runnerRoot, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies).toEqual({
      '@openquant/agents': 'workspace:*',
      '@openquant/api-contracts': 'workspace:*',
    });
  });
});
