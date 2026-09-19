import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_FILES, MAX_FILE_BYTES, WorkspaceStore } from '../../src/accounts/workspace';

let dir: string;
let store: WorkspaceStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'rcja-workspace-'));
  store = new WorkspaceStore({ dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('reading a workspace', () => {
  it('is empty rather than an error before a team has ever edited', async () => {
    expect(await store.read('ACT Robotics', 1)).toEqual([]);
  });

  it('keeps each robot and each team apart', async () => {
    await store.write('ACT Robotics', 1, 'robot.py', 'one');
    await store.write('ACT Robotics', 2, 'robot.py', 'two');
    await store.write('NSW', 1, 'robot.py', 'other');

    expect((await store.read('ACT Robotics', 1))[0]?.content).toBe('one');
    expect((await store.read('ACT Robotics', 2))[0]?.content).toBe('two');
    expect((await store.read('NSW', 1))[0]?.content).toBe('other');
  });

  it('ignores anything in the folder that is not a plain file', async () => {
    await store.write('NSW', 1, 'robot.py', 'kept');
    // A stray file an admin left behind, with a name the format does not allow.
    await writeFile(join(dir, 'nsw', '1', 'notes on the weekend.txt'), 'ignore me');
    const names = (await store.read('NSW', 1)).map((f) => f.name);
    expect(names).toEqual(['robot.py']);
  });
});

describe('saving', () => {
  it("creates the folder on a team's first edit", async () => {
    const result = await store.write('ACT Robotics', 1, 'robot.py', 'print(1)');
    expect(result.ok).toBe(true);
    expect(await readFile(join(dir, 'act-robotics', '1', 'robot.py'), 'utf8')).toBe('print(1)');
  });

  it('saves code that does not even parse', async () => {
    // An editor that refused to save broken code would be an editor you cannot
    // use — you would not be able to save halfway through a thought. The
    // validator's opinion is asked at submit time, not here.
    const result = await store.write('NSW', 1, 'robot.py', 'def broken(:');
    expect(result.ok).toBe(true);
  });

  it('refuses a filename that would escape the folder', async () => {
    for (const bad of ['../escape.py', 'sub/dir.py', '/etc/passwd', '.hidden.py', '']) {
      const result = await store.write('NSW', 1, bad, 'x');
      expect(result.ok, `${bad} should have been refused`).toBe(false);
    }
  });

  it('refuses a file that is not code or a manifest', async () => {
    const result = await store.write('NSW', 1, 'notes.txt', 'x');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('.py');
  });

  it('refuses a file past the size limit', async () => {
    const huge = 'x'.repeat(MAX_FILE_BYTES + 1);
    const result = await store.write('NSW', 1, 'robot.py', huge);
    expect(result.ok).toBe(false);
  });

  it('caps how many files a robot folder holds, but still lets them be edited', async () => {
    for (let i = 0; i < MAX_FILES; i++) {
      expect((await store.write('NSW', 1, `mod${i}.py`, 'x')).ok).toBe(true);
    }
    // One more file is refused...
    expect((await store.write('NSW', 1, 'one_too_many.py', 'x')).ok).toBe(false);
    // ...but overwriting one that already exists is not adding a file.
    expect((await store.write('NSW', 1, 'mod0.py', 'changed')).ok).toBe(true);
  });
});

describe('deleting', () => {
  it('removes a file', async () => {
    await store.write('NSW', 1, 'robot.py', 'x');
    await store.write('NSW', 1, 'helper.py', 'x');
    expect((await store.remove('NSW', 1, 'helper.py')).ok).toBe(true);
    expect((await store.read('NSW', 1)).map((f) => f.name)).toEqual(['robot.py']);
  });

  it('does not mind deleting something that was never there', async () => {
    expect((await store.remove('NSW', 1, 'ghost.py')).ok).toBe(true);
  });

  it('refuses an unsafe name rather than reaching outside the folder', async () => {
    expect((await store.remove('NSW', 1, '../../secret')).ok).toBe(false);
  });
});

describe('the starter robot', () => {
  it('fills an empty folder with something that actually runs', async () => {
    const files = await store.seed('ACT Robotics', 1);
    const names = files.map((f) => f.name);
    expect(names).toContain('manifest.json');
    expect(names).toContain('robot.py');

    const manifest = JSON.parse(files.find((f) => f.name === 'manifest.json')!.content);
    expect(manifest).toEqual({ team: 'ACT Robotics', robot: 1, entry: 'robot.py' });
  });

  it('names the robot the folder is for, not always robot 1', async () => {
    const files = await store.seed('NSW', 2);
    const manifest = JSON.parse(files.find((f) => f.name === 'manifest.json')!.content);
    expect(manifest.robot).toBe(2);
  });

  it('never overwrites work that is already there', async () => {
    await store.write('NSW', 1, 'robot.py', 'mine');
    const files = await store.seed('NSW', 1);
    expect(files).toHaveLength(1);
    expect(files[0]?.content).toBe('mine');
  });
});

describe('handing a workspace to the submit endpoint', () => {
  it('is the same base64 shape a push already takes', async () => {
    await store.seed('ACT Robotics', 1);
    const push = await store.asPush('ACT Robotics', 1);

    expect(Object.keys(push).sort()).toEqual(['manifest.json', 'robot.py']);
    const decoded = Buffer.from(push['robot.py']!, 'base64').toString('utf8');
    expect(decoded).toContain('Runtime.get()');
  });
});

/**
 * The copy Run takes.
 *
 * A snapshot rather than the folder itself is what makes typing during a run
 * safe, and what gives "which code is that" a fixed answer — so what matters
 * here is that it is a *copy*, that it is only the legal files, and that a
 * folder which cannot run says why in a sentence somebody can act on.
 */
describe('snapshotting a workspace to run it', () => {
  const runs: string[] = [];

  async function into(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'rcja-run-'));
    runs.push(root);
    return join(root, 'seat');
  }

  afterEach(async () => {
    for (const root of runs.splice(0)) await rm(root, { recursive: true, force: true });
  });

  it('copies the folder as it stands, and stops following it', async () => {
    await store.seed('ACT Robotics', 1);
    const dest = await into();

    const snapshot = await store.snapshot('ACT Robotics', 1, dest);
    expect(snapshot.ok).toBe(true);
    if (!snapshot.ok) return;
    expect(snapshot.value.manifest.entry).toBe('robot.py');

    const copied = await readFile(join(dest, 'robot.py'), 'utf8');
    expect(copied).toContain('Runtime.get()');

    // The editor carries on. The copy does not.
    await store.write('ACT Robotics', 1, 'robot.py', 'print("changed")');
    expect(await readFile(join(dest, 'robot.py'), 'utf8')).toBe(copied);
  });

  it('says what is wrong when the manifest does not parse', async () => {
    await store.write('ACT Robotics', 1, 'manifest.json', '{ not json');
    await store.write('ACT Robotics', 1, 'robot.py', 'pass');

    const snapshot = await store.snapshot('ACT Robotics', 1, await into());
    expect(snapshot.ok).toBe(false);
    if (snapshot.ok) return;
    expect(snapshot.reason).toContain('manifest.json');
  });

  it('says what is wrong when the entry point is not there', async () => {
    await store.write('ACT Robotics', 1, 'manifest.json', JSON.stringify({ team: 'ACT Robotics', robot: 1, entry: 'brain.py' }));
    await store.write('ACT Robotics', 1, 'robot.py', 'pass');

    const snapshot = await store.snapshot('ACT Robotics', 1, await into());
    expect(snapshot.ok).toBe(false);
    if (snapshot.ok) return;
    expect(snapshot.reason).toContain('brain.py');
  });

  it('refuses an empty workspace rather than running nothing', async () => {
    const snapshot = await store.snapshot('ACT Robotics', 2, await into());
    expect(snapshot.ok).toBe(false);
    if (snapshot.ok) return;
    expect(snapshot.reason).toContain('robot 2');
  });

  it('runs code whose manifest names somebody else, because identity is not in the file', async () => {
    // Who this robot belongs to comes from the credential. A team that copied a
    // manifest from a friend, or renamed itself, still gets to watch its code
    // run — a push is where that disagreement matters.
    await store.write('ACT Robotics', 1, 'manifest.json', JSON.stringify({ team: 'Someone Else', robot: 2, entry: 'robot.py' }));
    await store.write('ACT Robotics', 1, 'robot.py', 'pass');

    const snapshot = await store.snapshot('ACT Robotics', 1, await into());
    expect(snapshot.ok).toBe(true);
  });
});
