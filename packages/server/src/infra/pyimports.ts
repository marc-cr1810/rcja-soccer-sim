/**
 * What a Python file imports, without running it.
 *
 * "No dependencies" is a rule for the schools this league exists to reach,
 * not a security boundary — the boundary is the sandbox in `sandbox.ts`,
 * which is why this is allowed to be simple: parse the file with the
 * interpreter's own `ast` module and read off the names, never execute a
 * line of it. A submission that imports something outside the standard
 * library and `rcja_soccer` cannot run at a venue with no internet and no
 * pip, so it is rejected here, at push time, rather than found by a referee
 * mid-match.
 */

function pythonBin(): string {
  return process.env.RCJA_PYTHON ?? 'python3';
}

async function runPython(script: string, stdin: string): Promise<string> {
  const proc = Bun.spawn([pythonBin(), '-c', script], {
    stdin: Buffer.from(stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(err.trim() || `python3 exited ${code}`);
  return out;
}

const SCAN_SCRIPT = `
import ast, json, sys
source = sys.stdin.read()
try:
    tree = ast.parse(source)
except SyntaxError as e:
    print(json.dumps({"error": f"line {e.lineno}: {e.msg}"}))
    sys.exit(0)
modules = set()
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        for alias in node.names:
            modules.add(alias.name.split(".")[0])
    elif isinstance(node, ast.ImportFrom):
        if node.level == 0 and node.module:
            modules.add(node.module.split(".")[0])
print(json.dumps({"modules": sorted(modules)}))
`;

export type ScanResult = { modules: string[] } | { error: string };

/** The top-level modules a Python source file imports, or its syntax error. */
export async function scanImports(source: string): Promise<ScanResult> {
  const out = await runPython(SCAN_SCRIPT, source);
  return JSON.parse(out) as ScanResult;
}

let stdlibCache: Promise<Set<string>> | null = null;

/**
 * Every module name the running interpreter would resolve without pip.
 *
 * Asked of the same `python3` binary that will run a submission, and cached,
 * so the allowlist can never drift from what the venue's own interpreter
 * actually ships — there is no hand-kept list here to go stale between
 * Python versions.
 */
export function stdlibModules(): Promise<Set<string>> {
  if (!stdlibCache) {
    stdlibCache = runPython(
      'import sys, json; print(json.dumps(sorted(sys.stdlib_module_names)))',
      '',
    ).then((out) => new Set(JSON.parse(out) as string[]));
  }
  return stdlibCache;
}
