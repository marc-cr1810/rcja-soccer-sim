import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { scanImports, stdlibModules } from './pyimports';

const pythonAvailable = spawnSync('python3', ['--version']).status === 0;

describe.skipIf(!pythonAvailable)('scanImports', () => {
  it('lists the top-level modules a file imports', async () => {
    const result = await scanImports('from __future__ import annotations\nimport os, math\nfrom sys import argv\n');
    expect(result).toEqual({ modules: ['__future__', 'math', 'os', 'sys'] });
  });

  it('reports a syntax error instead of a module list', async () => {
    const result = await scanImports('def broken(:\n');
    expect(result).toHaveProperty('error');
  });

  it('does not execute the file', async () => {
    // If this ever ran the code instead of just parsing it, the process
    // spawned to do the scanning would exit non-zero and the promise would
    // reject rather than resolve with a module list.
    const result = await scanImports('import os\nraise RuntimeError("should never run")\n');
    expect(result).toEqual({ modules: ['os'] });
  });
});

describe.skipIf(!pythonAvailable)('stdlibModules', () => {
  it('includes the standard library and excludes third-party packages', async () => {
    const modules = await stdlibModules();
    expect(modules.has('os')).toBe(true);
    expect(modules.has('sys')).toBe(true);
    expect(modules.has('__future__')).toBe(true);
    expect(modules.has('numpy')).toBe(false);
    expect(modules.has('rcja_soccer')).toBe(false);
  });
});
