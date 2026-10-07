// Verifies that the add-in's keyboard shortcuts win over page shortcuts:
//   1. Manifests inject shortcuts.js at document_start — BEFORE any page
//      script runs — into all frames, and it precedes the content.js entry.
//      That is the actual priority guarantee: the guard is the first
//      listener on `window` in the capture phase, so no page handler (window
//      or document level, capture or bubble) can ever run before it.
//   2. The guard (sliced from the shipped shortcuts.js) registers
//      keydown+keyup capture listeners on `window`, asks content.js's hook
//      whether the combination is one of the add-in's shortcuts, and only
//      then consumes the event — keydown AND the matching keyup (pages that
//      implement shortcuts on keyup must lose too).
//   3. content.js returns the matched combination to the guard (hook
//      contract), installs the hook global and keeps a window-capture
//      fallback listener for targets without the guard.
//   4. The Thunderbird overlay registers the guard as a document_start
//      compose script and injects it into already-open compose tabs.
//
// Event propagation is modelled with a small simulator (window → document →
// target, capture then bubble, stopPropagation/stopImmediatePropagation) —
// this repo has no jsdom dependency. The model mirrors the DOM rules the
// guard depends on; the shipped file itself is what is evaluated here.

const fs = require('fs');

const contentSrc = fs.readFileSync(__dirname + '/content.js', 'utf8');
const guardSrc = fs.readFileSync(__dirname + '/shortcuts.js', 'utf8');
const buildSrc = fs.readFileSync(__dirname + '/tools/build.mjs', 'utf8');
const tbBg = fs.readFileSync(__dirname + '/platform/thunderbird/background.js', 'utf8');
const rootManifest = JSON.parse(fs.readFileSync(__dirname + '/manifest.json', 'utf8'));
const ffManifest = JSON.parse(fs.readFileSync(__dirname + '/platform/firefox/manifest.json', 'utf8'));

let fails = 0;
const check = (label, ok, detail) => {
  if (!ok) fails++;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + (detail ? ' — ' + detail : ''));
};

// --- 1) manifests: document_start guard ------------------------------------
function guardEntry(m) {
  const list = (m && m.content_scripts) || [];
  const idx = list.findIndex((cs) => (cs.js || []).includes('shortcuts.js'));
  return idx < 0 ? null : { idx, cs: list[idx], list };
}
const rg = guardEntry(rootManifest);
const fg = guardEntry(ffManifest);

check('M1: root manifest injects shortcuts.js at document_start',
  !!rg && rg.cs.run_at === 'document_start',
  rg ? 'run_at=' + rg.cs.run_at : 'entry missing');
check('M2: root manifest guard covers all frames',
  !!rg && rg.cs.all_frames === true && rg.cs.match_about_blank === true);
check('M3: guard entry precedes the content.js entry (registers first)',
  !!rg && rg.list.findIndex((cs) => (cs.js || []).includes('content.js')) > rg.idx);
check('M4: firefox overlay injects the same guard entry',
  !!fg && fg.cs.run_at === 'document_start' &&
  fg.cs.all_frames === true && fg.cs.match_about_blank === true);
check('M5: build.mjs ships shortcuts.js to every target',
  /sharedFiles = \[[^\]]*'shortcuts\.js'/.test(buildSrc));

// --- 2) guard behaviour (shipped shortcuts.js under an event model) ---------
function makePropagationModel() {
  const listeners = { window: [], document: [], target: [] };
  const makeNode = (name) => ({
    addEventListener(type, fn, capture) {
      listeners[name].push({ type, fn, capture: !!capture });
    }
  });
  const win = makeNode('window');
  const doc = makeNode('document');
  const target = makeNode('target');

  function runOn(name, phase, event) {
    for (const l of listeners[name]) {
      if (l.type !== event.type || l.capture !== phase) continue;
      l.fn(event);
      if (event.__immediate) return true;
    }
    return false;
  }

  function makeEvent(type, props) {
    return Object.assign({
      type,
      ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, key: '',
      defaultPrevented: false, __stopped: false, __immediate: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.__stopped = true; },
      stopImmediatePropagation() { this.__stopped = true; this.__immediate = true; }
    }, props || {});
  }

  function dispatch(event) {
    const path = ['window', 'document', 'target'];
    for (const name of path) {
      if (runOn(name, true, event)) return event;
      if (event.__stopped) return event;
    }
    for (const name of path.slice().reverse()) {
      if (runOn(name, false, event)) return event;
      if (event.__stopped) return event;
    }
    return event;
  }

  return { win, doc, target, listeners, makeEvent, dispatch };
}

// Load the shipped guard against a model window; hook = content.js's handler.
function loadGuard(model, hook) {
  if (hook === undefined) delete globalThis.__llmShortcutGuard;
  else globalThis.__llmShortcutGuard = hook;
  new Function('window', guardSrc)(model.win);
}

const isBound = (e) => (e.ctrlKey && e.shiftKey && e.key === 'T') ? 'Ctrl+Shift+T' : null;

// G1: registration — window, capture phase, keydown AND keyup (and nothing on
// document, which is what the page-level handlers use).
{
  const m = makePropagationModel();
  loadGuard(m, isBound);
  const kd = m.listeners.window.filter((l) => l.type === 'keydown');
  const ku = m.listeners.window.filter((l) => l.type === 'keyup');
  check('G1: guard registers keydown+keyup capture listeners on window',
    kd.length === 1 && kd[0].capture === true &&
    ku.length === 1 && ku[0].capture === true &&
    m.listeners.document.length === 0,
    'keydown=' + kd.length + ' keyup=' + ku.length + ' document=' + m.listeners.document.length);
}

// G2/G3: a bound combination never reaches the page, keydown + keyup.
{
  const m = makePropagationModel();
  let hookCalls = 0, pageKeydown = 0, pageKeyup = 0;
  loadGuard(m, (e) => { hookCalls++; return isBound(e); });
  // Page registers AFTER the guard (what document_start guarantees).
  m.win.addEventListener('keydown', () => { pageKeydown++; }, true);
  m.win.addEventListener('keyup', () => { pageKeyup++; }, true);

  const down = m.dispatch(m.makeEvent('keydown', { ctrlKey: true, shiftKey: true, key: 'T' }));
  check('G2: bound shortcut is consumed before any page listener',
    hookCalls === 1 && pageKeydown === 0 && down.defaultPrevented === true && down.__stopped === true,
    'hook=' + hookCalls + ' page=' + pageKeydown + ' prevented=' + down.defaultPrevented);

  const up = m.dispatch(m.makeEvent('keyup', { ctrlKey: true, shiftKey: true, key: 'T' }));
  check('G3: the matching keyup is consumed too (keyup-based page handlers lose)',
    pageKeyup === 0 && up.defaultPrevented === true);
}

// G4: an unbound combination passes through untouched.
{
  const m = makePropagationModel();
  let pageSaw = 0;
  loadGuard(m, isBound);
  m.win.addEventListener('keydown', () => { pageSaw++; }, true);
  const ev = m.dispatch(m.makeEvent('keydown', { ctrlKey: true, key: 'z' }));
  check('G4: unbound combination reaches the page untouched',
    pageSaw === 1 && ev.defaultPrevented === false && ev.__stopped === false);
}

// G5: no hook yet (content.js not initialised) -> nothing is swallowed.
{
  const m = makePropagationModel();
  let pageSaw = 0;
  loadGuard(m, undefined);
  m.win.addEventListener('keydown', () => { pageSaw++; }, true);
  const ev = m.dispatch(m.makeEvent('keydown', { ctrlKey: true, shiftKey: true, key: 'T' }));
  check('G5: without the hook the guard is a no-op', pageSaw === 1 && ev.defaultPrevented === false);
}

// G6: a throwing hook must not block the page either.
{
  const m = makePropagationModel();
  let pageSaw = 0, threw = false;
  loadGuard(m, () => { throw new Error('boom'); });
  m.win.addEventListener('keydown', () => { pageSaw++; }, true);
  try {
    m.dispatch(m.makeEvent('keydown', { ctrlKey: true, key: 'T' }));
  } catch (e) { threw = true; }
  check('G6: a broken hook cannot block the page', pageSaw === 1 && threw === false);
}

// G7: only the keydown that was consumed swallows a keyup — a stray keyup
// (different key) still reaches the page.
{
  const m = makePropagationModel();
  let pageKeyup = 0;
  loadGuard(m, isBound);
  m.win.addEventListener('keyup', () => { pageKeyup++; }, true);
  m.dispatch(m.makeEvent('keydown', { ctrlKey: true, shiftKey: true, key: 'T' }));
  m.dispatch(m.makeEvent('keyup', { ctrlKey: true, shiftKey: true, key: 'T' })); // consumed
  m.dispatch(m.makeEvent('keyup', { key: 'T' }));                                // stray
  check('G7: only the consumed combination\'s keyup is swallowed', pageKeyup === 1);
}

// --- 3) content.js: hook contract + listener -------------------------------
function extractFn(name) {
  const start = contentSrc.indexOf('function ' + name);
  if (start < 0) { console.error('FAIL: ' + name + ' not found in content.js'); process.exit(2); }
  let i = contentSrc.indexOf('{', start), depth = 0, end = null;
  for (let idx = i; idx < contentSrc.length; idx++) {
    if (contentSrc[idx] === '{') depth++;
    else if (contentSrc[idx] === '}') { depth--; if (depth === 0) { end = idx + 1; break; } }
  }
  return contentSrc.slice(start, end);
}

const serialize = new Function(extractFn('serializeKeyboardEvent') + '\nreturn serializeKeyboardEvent;')();
const findAction = new Function('builtinShortcuts', 'customActions', 'freePromptShortcut',
  extractFn('findActionForShortcut') + '\nreturn findActionForShortcut;')(
  { translate: 'Ctrl+Shift+T' }, [], '');

function makeHandler(resolver) {
  const state = { executed: null, chat: 0 };
  const fn = new Function(
    'resolveEditingTarget', 'serializeKeyboardEvent', 'findActionForShortcut',
    'builtinShortcuts', 'customActions', 'freePromptShortcut',
    'activeInputElement', 'uiSuspended', 'openFreePromptChat', 'executeAction',
    extractFn('handleShortcutKeydown') + '\nreturn handleShortcutKeydown;'
  )(
    resolver, serialize, findAction,
    { translate: 'Ctrl+Shift+T' }, [], '',
    null, false,
    () => { state.chat++; },
    (id) => { state.executed = id; }
  );
  return { fn, state };
}

const fakeEvent = (props) => Object.assign({
  defaultPrevented: false, __stopped: false,
  preventDefault() { this.defaultPrevented = true; },
  stopPropagation() { this.__stopped = true; },
  stopImmediatePropagation() { this.__stopped = true; }
}, props);

// H1: bound combination + focused field -> action runs AND the combination is
// reported back (that truthy return value is what makes the guard swallow).
{
  const { fn, state } = makeHandler(() => ({ tagName: 'TEXTAREA' }));
  const ev = fakeEvent({ ctrlKey: true, shiftKey: true, key: 'T' });
  const ret = fn(ev);
  check('H1: content.js reports the matched combination to the guard',
    ret === 'Ctrl+Shift+T' && state.executed === 'translate' && ev.defaultPrevented === true,
    'ret=' + ret + ' action=' + state.executed);
}
// H2: no text field focused -> null (the page keeps its own shortcut).
{
  const { fn, state } = makeHandler(() => null);
  const ev = fakeEvent({ ctrlKey: true, shiftKey: true, key: 'T' });
  check('H2: no focused field -> null, event untouched',
    fn(ev) === null && state.executed === null && ev.defaultPrevented === false);
}
// H3: unbound combination -> null.
{
  const { fn, state } = makeHandler(() => ({ tagName: 'TEXTAREA' }));
  const ev = fakeEvent({ ctrlKey: true, shiftKey: true, key: 'Q' });
  check('H3: unbound combination -> null, event untouched',
    fn(ev) === null && state.executed === null && ev.defaultPrevented === false);
}
// H4/H5: wiring in init().
check('H4: content.js installs the guard hook global',
  /globalThis\.__llmShortcutGuard = handleShortcutKeydown/.test(contentSrc));
check('H5: content.js listens on window (capture), not document, as fallback',
  /window\.addEventListener\('keydown', handleShortcutKeydown, true\)/.test(contentSrc) &&
  !/document\.addEventListener\('keydown', handleShortcutKeydown, true\)/.test(contentSrc));
check('H6: matched shortcuts use stopImmediatePropagation',
  /e\.stopImmediatePropagation\(\);/.test(extractFn('handleShortcutKeydown')));

// --- 3b) the add-in's own UI must not leak keystrokes to the page ----------
// A page keydown handler on `document` (MiniKanban's board-shortcuts.js is the
// reference case) checks `isTyping(e.target)`. For a CLOSED shadow root the page
// sees e.target retargeted to the host <div>, so the check fails, the handler
// calls preventDefault() and the character is swallowed — and its shortcut
// actions even steal the focus. content.js therefore stops propagation of
// key events at the shadow root (bubble phase), which is exactly between the
// input and the page's document listener.
function makeUiRoot() {
  const listeners = [];
  const shadow = {
    addEventListener(type, fn, capture) { listeners.push({ type, fn, capture: !!capture }); }
  };
  const host = {
    id: '',
    attachShadow() { return shadow; },
    isConnected: true
  };
  const documentStub = {
    querySelectorAll: () => [],
    createElement: () => host,
    body: { appendChild() {} },
    documentElement: { appendChild() {} }
  };
  // uiHost/uiRoot/uiSuspended are IIFE-scoped in content.js -> declare them as
  // locals of the wrapper so the sliced function assigns into this closure.
  const getUiRoot = new Function('document', `
    let uiHost = null;
    let uiRoot = null;
    let uiSuspended = false;
    ${extractFn('getUiRoot')}
    return getUiRoot;
  `)(documentStub);
  return { getUiRoot, listeners, host, shadow };
}

const ui = makeUiRoot();
const root = ui.getUiRoot();

check('U1: shadow root swallows key events from the add-in UI (keydown/keyup/keypress, bubble)',
  root === ui.shadow && ui.listeners.length === 3 &&
  ['keydown', 'keyup', 'keypress'].every((t) =>
    ui.listeners.some((l) => l.type === t && l.capture === false)),
  'listeners=' + JSON.stringify(ui.listeners.map((l) => l.type + (l.capture ? ':capture' : ':bubble'))));

// Minimal propagation model with the shadow root between document and target.
function fireThrough(nodes, path, ev) {
  for (const n of path) {
    for (const l of nodes[n]) {
      if (l.type !== ev.type || !l.capture) continue;
      l.fn(ev);
      if (ev.__immediate) return;
    }
    if (ev.__stopped) return;
  }
  for (const n of path.slice().reverse()) {
    for (const l of nodes[n]) {
      if (l.type !== ev.type || l.capture) continue;
      l.fn(ev);
      if (ev.__immediate) return;
    }
    if (ev.__stopped) return;
  }
}
const UI_PATH = ['window', 'document', 'shadowRoot', 'target'];
const makeKeyEvent = (props) => Object.assign({
  type: 'keydown', key: 'n', defaultPrevented: false, __stopped: false, __immediate: false,
  preventDefault() { this.defaultPrevented = true; },
  stopPropagation() { this.__stopped = true; },
  stopImmediatePropagation() { this.__stopped = true; this.__immediate = true; }
}, props);

function uiCase(installShippedListeners) {
  const nodes = { window: [], document: [], shadowRoot: [], target: [] };
  const add = (n, type, fn, capture) => nodes[n].push({ type, fn, capture: !!capture });
  const state = { pageRuns: 0, inputRuns: 0, guardRuns: 0 };

  if (installShippedListeners) {
    for (const l of ui.listeners) add('shadowRoot', l.type, l.fn, l.capture);
  }
  // The page's handler, exactly like board-shortcuts.js: document, bubble.
  add('document', 'keydown', (e) => { state.pageRuns++; e.preventDefault(); }, false);
  // The input's own Enter handler (target phase) must still run.
  add('target', 'keydown', () => { state.inputRuns++; }, false);
  // The add-in's shortcut guard: window, capture (registered at document_start).
  add('window', 'keydown', () => { state.guardRuns++; }, true);

  const ev = makeKeyEvent({});
  fireThrough(nodes, UI_PATH, ev);
  return { state, ev };
}

{
  const { state, ev } = uiCase(true);
  check('U2: a page keydown handler on document never sees our UI keystrokes',
    state.pageRuns === 0 && ev.defaultPrevented === false && ev.__stopped === true,
    'pageRuns=' + state.pageRuns + ' prevented=' + ev.defaultPrevented);
  check('U3: the input itself still receives the keystroke',
    state.inputRuns === 1, 'inputRuns=' + state.inputRuns);
  check('U4: the add-in shortcut guard (window capture) still sees it',
    state.guardRuns === 1, 'guardRuns=' + state.guardRuns);
}
{
  // Control: without the shipped listeners the page handler swallows the key —
  // this is the reported bug, so the test above is meaningful.
  const { state, ev } = uiCase(false);
  check('U5: control — without the listeners the page handler swallows the character',
    state.pageRuns === 1 && ev.defaultPrevented === true);
}

// --- 4) Thunderbird overlay ------------------------------------------------
check('T1: TB registers the guard as a document_start compose script',
  /id: "llm-compose-shortcut-guard",\s*js: \["\/shortcuts\.js"\],\s*runAt: "document_start"/.test(tbBg));
check('T2: TB still registers content.js and falls back if the guard is rejected',
  /id: "llm-compose-script", js: \["\/content\.js"\]/.test(tbBg) &&
  /registerScripts\(\[mainScript\]\)/.test(tbBg));
check('T3: TB injects the guard into already-open compose tabs first',
  /files: \["\/shortcuts\.js", "\/content\.js"\]/.test(tbBg));

console.log(fails === 0 ? '\nALL TESTS PASSED' : '\n' + fails + ' FAILURES');
process.exit(fails ? 1 : 0);
