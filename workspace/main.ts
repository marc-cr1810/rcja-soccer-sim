/// <reference types="vite/client" />
/**
 * The team workspace: write your robot in a browser, on the venue's server.
 *
 * This is for the student on a school machine that will not let them install
 * Python, an editor, or anything else. Everything they need is already on the
 * venue's computer — CPython, the sandbox, the simulator, the practice fields —
 * so what is missing is somewhere to keep their code and a way to type into it.
 * That is all this page is.
 *
 * Nothing about a robot runs in this tab. The code is saved to the server and
 * runs there, under the same sandbox and against the same simulator a scored
 * match uses. Running it here instead would be easier and would be a lie: a
 * rehearsal on a different Python, without the CPU and memory ceilings, is a
 * rehearsal of a different sport.
 *
 * Who the team is comes from the credential, and there are two of them now.
 * On a match server it is the hand-issued secret this page asks for, matching
 * the push token from Phase 1 and the referee's from Phase 2. On a league
 * server it is the session the team already has, so there is nothing to paste
 * and the gate never appears — the page asks the server who it is talking to
 * before showing a login for a secret nobody issued. Nothing else about this
 * page changed when accounts arrived, which was the promise.
 */

import { CodeEditor } from './editor';

type RobotNumber = 1 | 2;

interface WorkspaceFile {
  name: string;
  content: string;
}

/**
 * Everything is relative to where the page was served from.
 *
 * The bundle lives at `/workspace/` and the API at `/workspace-api/`, so the
 * prefix is whatever comes before that last segment. Deriving it from
 * `location` rather than hard-coding `/` is what lets a venue mount the server
 * under a path without rebuilding anything.
 */
const BASE = location.pathname.replace(/workspace\/?$/, '');

const TOKEN_KEY = 'rcja.workspace.token';

const el = {
  gate: document.getElementById('gate')!,
  gateForm: document.getElementById('gate-form') as HTMLFormElement,
  gateError: document.getElementById('gate-error')!,
  token: document.getElementById('token') as HTMLInputElement,
  app: document.getElementById('app')!,
  team: document.getElementById('team')!,
  robots: document.getElementById('robots')!,
  saved: document.getElementById('saved')!,
  submit: document.getElementById('submit') as HTMLButtonElement,
  run: document.getElementById('run') as HTMLButtonElement,
  logout: document.getElementById('logout')!,
  fileList: document.getElementById('file-list')!,
  newFileForm: document.getElementById('new-file-form') as HTMLFormElement,
  newFile: document.getElementById('new-file') as HTMLInputElement,
  activeName: document.getElementById('active-name')!,
  code: document.getElementById('code')!,
  consoleBody: document.getElementById('console-body')!,
  clearConsole: document.getElementById('clear-console')!,
};

let token = '';
let robot: RobotNumber = 1;
const files = new Map<string, string>();
let active: string | null = null;
/** Files changed since they were last written to the server. */
const unsaved = new Set<string>();

/* --- talking to the server --- */

async function api(action: string, body: Record<string, unknown> = {}): Promise<any> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // On a league server there is no secret to paste: the team signed in to the
  // site and the session cookie the browser already sends says who they are.
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${BASE}workspace-api/${action}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ robot, ...body }),
  });
  const payload = await response.json().catch(() => ({ ok: false, reason: 'the server said nothing' }));
  return { status: response.status, ...payload };
}

/* --- the output panel --- */

function say(text: string, kind: 'note' | 'good' | 'bad' = 'note'): void {
  const line = document.createElement('div');
  line.className = kind;
  line.textContent = text;
  el.consoleBody.append(line);
  el.consoleBody.scrollTop = el.consoleBody.scrollHeight;
}

/* --- the file list --- */

function renderFiles(): void {
  el.fileList.replaceChildren();
  for (const name of [...files.keys()].sort()) {
    const item = document.createElement('li');
    item.className = name === active ? 'on' : '';

    const open = document.createElement('button');
    open.className = 'name';
    open.textContent = name + (unsaved.has(name) ? ' •' : '');
    open.addEventListener('click', () => void openFile(name));
    item.append(open);

    // The entry point and the manifest are what make this a submission. Losing
    // either by a stray click is a bad afternoon, so they have no delete.
    if (name !== 'manifest.json' && name !== entryName()) {
      const remove = document.createElement('button');
      remove.className = 'remove';
      remove.title = `Delete ${name}`;
      remove.textContent = '×';
      remove.addEventListener('click', () => void deleteFile(name));
      item.append(remove);
    }

    el.fileList.append(item);
  }
}

/** Whatever manifest.json currently calls the entry point. */
function entryName(): string {
  try {
    return JSON.parse(files.get('manifest.json') ?? '{}').entry ?? 'robot.py';
  } catch {
    return 'robot.py';
  }
}

/* --- editing --- */

const editor = new CodeEditor(el.code, {
  onChange: () => touched(),
  onSave: () => void saveActive(),
});

async function openFile(name: string): Promise<void> {
  if (active && active !== name) await saveActive();
  active = name;
  editor.show(files.get(name) ?? '');
  el.activeName.textContent = name;
  renderFiles();
  editor.focus();
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function touched(): void {
  if (!active) return;
  const text = editor.text;
  // `show()` counts as a change, so a file that was only opened is not dirty.
  if (text === files.get(active)) return;
  files.set(active, text);
  unsaved.add(active);
  el.saved.textContent = 'unsaved';
  el.saved.className = 'saved dim';
  renderFiles();
  // Save shortly after they stop typing. A student should never have to think
  // about saving, and should never lose a line because they closed a laptop.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void saveActive(), 700);
}

async function saveActive(): Promise<void> {
  if (!active || !unsaved.has(active)) return;
  const name = active;
  const content = files.get(name) ?? '';
  const result = await api('save', { name, content });
  if (!result.ok) {
    say(`could not save ${name}: ${result.reason}`, 'bad');
    return;
  }
  unsaved.delete(name);
  el.saved.textContent = 'saved';
  el.saved.className = 'saved good';
  renderFiles();
}

async function deleteFile(name: string): Promise<void> {
  if (!confirm(`Delete ${name}? This cannot be undone.`)) return;
  const result = await api('delete', { name });
  if (!result.ok) {
    say(`could not delete ${name}: ${result.reason}`, 'bad');
    return;
  }
  files.delete(name);
  unsaved.delete(name);
  if (active === name) {
    active = null;
    editor.show('');
    editor.setEnabled(false);
    el.activeName.textContent = 'nothing open';
  }
  load(result.files as WorkspaceFile[]);
  say(`deleted ${name}`);
}

/* --- loading a workspace --- */

function load(incoming: WorkspaceFile[]): void {
  files.clear();
  for (const file of incoming) files.set(file.name, file.content);
  renderFiles();
  if (active && !files.has(active)) active = null;
  if (!active) {
    const first = files.has(entryName()) ? entryName() : [...files.keys()].sort()[0];
    if (first) void openFile(first);
  }
}

async function openWorkspace(
  which: RobotNumber,
  opts: { quiet?: boolean } = {},
): Promise<boolean> {
  await saveActive();
  robot = which;
  const result = await api('open');
  if (!result.ok) {
    if (result.status === 401) {
      forget();
      // Quiet on the way in: "that secret is wrong" is the wrong thing to say
      // to somebody who has not typed one yet, which is every first visit.
      if (!opts.quiet) {
        el.gateError.textContent = 'That secret is not one this server knows.';
        el.gateError.hidden = false;
      }
    } else if (!opts.quiet) {
      say(result.reason ?? 'could not open the workspace', 'bad');
    }
    return false;
  }

  el.team.textContent = result.team;
  document.title = `${result.team} — Your Robot`;
  active = null;
  unsaved.clear();
  load(result.files as WorkspaceFile[]);
  for (const button of el.robots.querySelectorAll('button')) {
    button.classList.toggle('on', Number(button.dataset.robot) === robot);
  }
  return true;
}

/* --- running it --- */

/**
 * Open a field, put this robot on it, and go and watch.
 *
 * Every step of this is something a team could do by hand — open a practice
 * field, then choose their own workspace in a seat — and the whole value is
 * that they do not have to. The loop this makes possible is measured in
 * seconds, and each page between typing and watching is spent out of it.
 *
 * Saved first, always: what runs is a copy the server takes when this request
 * arrives, so an unsaved buffer would put the *previous* version on the field
 * and the student would be debugging code they had already fixed.
 */
async function run(): Promise<void> {
  await saveActive();
  el.run.disabled = true;
  el.run.textContent = 'Starting…';
  say(`running robot ${robot}…`);

  let result: { ok?: boolean; reason?: string; field?: { url?: string } };
  try {
    const response = await fetch(`${BASE}practice/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ robot }),
    });
    result = await response.json().catch(() => ({ ok: false, reason: 'the server said nothing' }));
  } catch (err) {
    result = { ok: false, reason: (err as Error).message };
  }
  el.run.disabled = false;
  el.run.textContent = 'Run it';

  if (!result.ok || !result.field?.url) {
    // Queued, every field in use, practice closed: all three are already
    // phrased for a person by the server that decided them.
    say(result.reason ?? 'could not open a field', 'bad');
    return;
  }
  location.href = result.field.url;
}

/**
 * Only a server with fields to give has this button.
 *
 * A match server on a laptop hosts workspaces but has no accounts, no
 * ownership and nothing to decide whose field is whose, so it answers 404 to
 * this and the button simply is not there — the same way the practice console
 * discovers it is on a laptop.
 */
async function offersFields(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}practice`, { headers: { accept: 'application/json' } });
    if (!response.ok) return false;
    // Said outright rather than inferred from the shape of the answer: a
    // standalone match server also lists fields here, and it has no Run.
    const payload = (await response.json().catch(() => ({}))) as { run?: boolean };
    return payload.run === true;
  } catch {
    return false;
  }
}

/* --- pushing to the competition --- */

async function submit(): Promise<void> {
  await saveActive();
  el.submit.disabled = true;
  el.submit.textContent = 'Checking…';
  say(`pushing robot ${robot}…`);

  const result = await api('submit');
  el.submit.disabled = false;
  el.submit.textContent = 'Push to the competition';

  if (!result.ok) {
    // The validator's reason is written for a fifteen-year-old to act on, so
    // it is shown as-is rather than wrapped in something vaguer.
    say(result.reason ?? 'the push was refused', 'bad');
    return;
  }
  say(`accepted — ${result.team} robot ${result.robot} is now what will play.`, 'good');
}

/* --- getting in and out --- */

function forget(): void {
  token = '';
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // A browser with storage switched off. Signing out still works; it just
    // was not remembering anything to begin with.
  }
  el.app.hidden = true;
  el.gate.hidden = false;
}

el.gateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  el.gateError.hidden = true;
  token = el.token.value.trim();
  if (!token) return;

  if (await openWorkspace(1)) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      // Not remembered between visits; everything else still works.
    }
    el.gate.hidden = true;
    el.app.hidden = false;
    el.token.value = '';
    say('signed in — your code is saved on the server as you type');
  }
});

el.robots.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button');
  if (!button) return;
  void openWorkspace(Number(button.dataset.robot) === 2 ? 2 : 1);
});

el.newFileForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = el.newFile.value.trim();
  if (!name) return;
  if (files.has(name)) {
    void openFile(name);
    el.newFile.value = '';
    return;
  }
  const result = await api('save', { name, content: `"""${name}"""\n` });
  if (!result.ok) {
    say(result.reason ?? 'could not add that file', 'bad');
    return;
  }
  files.set(name, `"""${name}"""\n`);
  el.newFile.value = '';
  renderFiles();
  void openFile(name);
});

el.submit.addEventListener('click', () => void submit());
el.run.addEventListener('click', () => void run());
el.run.hidden = true;
void offersFields().then((yes) => {
  el.run.hidden = !yes;
});
el.logout.addEventListener('click', forget);
el.clearConsole.addEventListener('click', () => el.consoleBody.replaceChildren());

// Anything typed but not yet written, written now — a tab being closed or a
// laptop lid coming down is the most common way a line of code gets lost.
//
// `keepalive` rather than `sendBeacon`, which cannot set a header and so could
// not present the team's token at all: a beacon here would have looked like it
// was saving and have been refused every time.
addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return;
  if (!active || !unsaved.has(active)) return;
  void fetch(`${BASE}workspace-api/save`, {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ robot, name: active, content: files.get(active) }),
  }).catch(() => {
    // The page is going away; there is nobody left to tell.
  });
});


// A refresh should not cost a sign-in — and on a league server neither should
// a first visit, because the team is already signed in to the site. Opening
// with whatever credential exists (a remembered secret, a session cookie, or
// nothing at all) and letting the server answer is one path rather than two.
try {
  token = localStorage.getItem(TOKEN_KEY) ?? '';
} catch {
  // No storage. Everything below still works; nothing is remembered.
}
void openWorkspace(1, { quiet: true }).then((ok) => {
  if (!ok) return;
  el.gate.hidden = true;
  el.app.hidden = false;
});
