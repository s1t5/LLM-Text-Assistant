// Verifies the free-prompt focus/caret restore (v1.6.6, Thunderbird bug):
// opening the chat window focuses its input; closing it used to leave the
// document without an editable target — in Thunderbird document.body IS the
// compose body, so the mail could not be typed into until the user clicked
// it again.
//
// v1.7.2 adds the "invisible caret after copying an answer" case: selecting a
// chat answer puts the document selection into the extension's shadow root.
// The overlay is removed while that selection is still anchored in its
// subtree, and Thunderbird's editor re-asserts its own selection
// asynchronously after the DOM changed. Both leave the mail without a painted
// caret while typing still works (the editor keeps its own caret).
//
// Slices the real functions out of content.js:
//   captureCaretRange  — remembers the caret inside the edited field
//   restoreEditorFocus — focuses the field again, re-anchors the caret and
//                        re-asserts it once after the editor settled
//   selectionLivesIn   — is the live selection anchored inside the field?
//   fieldOwnsFocus     — field (or a descendant) still focused?
//   dropUiSelection    — clears a selection parked in the extension UI
//   closeChatWindow    — must call restoreEditorFocus with the field it was
//                        opened from (pendingElement, else activeInputElement)
//                        and drop the UI selection before removing the overlay
//
// Groups:
//   C — captureCaretRange: inside / outside / no selection
//   R — restoreEditorFocus: live range, stale range -> end, input/textarea,
//       detached element, async re-assert (fires / respects the user)
//   D — dropUiSelection: shadow-root selection, retargeted host, outside
//   W — closeChatWindow wiring: pendingElement, activeInputElement fallback,
//       teardown, UI selection dropped before the overlay is removed

const fs = require('fs');
const src = fs.readFileSync(process.argv[2] || (__dirname + '/content.js'), 'utf8');

function extractFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) { console.error('FAIL: ' + name + ' not found in content.js'); process.exit(2); }
  let i = src.indexOf('{', start), depth = 0, end = null;
  for (let idx = i; idx < src.length; idx++) {
    if (src[idx] === '{') depth++;
    else if (src[idx] === '}') { depth--; if (depth === 0) { end = idx + 1; break; } }
  }
  return src.slice(start, end);
}

let fails = 0;
const check = (label, ok, detail) => {
  if (!ok) fails++;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + (detail ? ' — ' + detail : ''));
};

// --- C: captureCaretRange ---------------------------------------------------
{
  const node = { isConnected: true, nodeType: 3, length: 5 };
  const outsideNode = { isConnected: true, nodeType: 3, length: 5 };
  const el = { tagName: 'DIV', isContentEditable: true, contains(n) { return n === node; } };

  const run = (range, rangeCount, memory) => {
    const win = {
      getSelection: () => ({
        rangeCount: rangeCount === undefined ? (range ? 1 : 0) : rangeCount,
        getRangeAt: () => range
      })
    };
    const fn = new Function('window', 'isNodeInDocument', 'lastFieldCaret',
      extractFn('captureCaretRange') + '\nreturn captureCaretRange;')(
      win, (n) => !!(n && n.isConnected), memory === undefined ? null : memory
    );
    return fn(el);
  };

  const inside = {
    commonAncestorContainer: node,
    startContainer: node,
    cloneRange() { return { cloned: true }; }
  };
  const outside = {
    commonAncestorContainer: outsideNode,
    startContainer: outsideNode,
    cloneRange() { return { cloned: true }; }
  };

  const r1 = run(inside);
  check('C1 caret inside the field is remembered', !!(r1 && r1.cloned));
  check('C2 caret outside the field is not captured', run(outside) === null);
  check('C3 no selection -> null', run(null) === null);
  check('C4 rangeCount 0 -> null', run(inside, 0) === null);

  // Toolbar popup emptied the live selection: the remembered caret wins.
  const remembered = {
    startContainer: { isConnected: true },
    commonAncestorContainer: { isConnected: true },
    cloneRange() { return { remembered: true }; }
  };
  const r5 = run(null, 0, { el, range: remembered });
  check('C5 empty live selection falls back to the remembered caret',
    !!(r5 && r5.remembered));

  const r6 = run(null, 0, {
    el,
    range: { startContainer: { isConnected: false }, cloneRange() { return { stale: true }; } }
  });
  check('C6 stale memory is not used', r6 === null);
}

// --- R: restoreEditorFocus --------------------------------------------------
// Builds a fake document/selection around the REAL sliced helpers, so the
// re-assert guards are exercised, not stubbed. Timers are queued and run on
// demand — that is what the async re-assert needs.
function runRestore(opts) {
  opts = opts || {};
  const calls = { focus: 0, addRange: 0, anchored: 0, removeAll: 0, blur: 0, sinkFocus: 0, sinkRemoved: 0, nudge: 0, nudgeCmd: 0 };
  const node = { isConnected: opts.nodeConnected !== false, nodeName: '#text', nodeType: 3 };
  const detached = { isConnected: false, nodeName: '#text', nodeType: 3 };
  const el = {
    tagName: opts.tagName || 'DIV',
    isContentEditable: opts.ce !== false,
    isConnected: opts.elConnected !== false,
    nodeType: 1,
    contains(n) { return n === node || n === el; },
    focus() { calls.focus++; },
    blur() { calls.blur++; }
  };
  const selState = { ranges: [], anchorNode: null };
  const selection = {
    get rangeCount() { return selState.ranges.length; },
    get anchorNode() { return selState.anchorNode; },
    removeAllRanges() { calls.removeAll++; selState.ranges = []; selState.anchorNode = null; },
    addRange(r) { calls.addRange++; selState.ranges = [r]; selState.anchorNode = r.startContainer; }
  };
  const doc = {
    activeElement: opts.activeElement === undefined ? el : opts.activeElement,
    body: opts.body || el,
    hasFocus() { return opts.hasFocus !== false; }
  };
  let windowFocus = 0;
  if (!opts.noCreateElement) {
    doc.createElement = () => ({
      setAttribute() {},
      style: {},
      focus() { calls.sinkFocus++; },
      remove() { calls.sinkRemoved++; }
    });
    doc.documentElement = { appendChild() {} };
  }
  const timers = [];
  const factory = new Function(
    'window', 'document', 'isNodeInDocument', 'anchorCaretAtEnd', 'logCaretState',
    'requestAnimationFrame', 'setTimeout', 'nudgeEditorAtCaret', 'nudgeEditorByCommand', `
    let userInteractToken = 0;
    ${extractFn('caretIsUsable')}
    ${extractFn('fieldOwnsFocus')}
    ${extractFn('restoreEditorFocus')}
    return {
      restoreEditorFocus, caretIsUsable, fieldOwnsFocus,
      bumpUser() { userInteractToken++; }
    };
  `);
  const api = factory(
    { getSelection: () => selection, focus() { windowFocus++; } },
    doc,
    (n) => !!(n && n.isConnected),
    () => { calls.anchored++; selState.anchorNode = el; selState.ranges = [{ startContainer: el }]; },
    () => {},
    (cb) => { timers.push(cb); return timers.length; },
    (cb) => { timers.push(cb); return timers.length; },
    () => { calls.nudge++; return true; },
    () => { calls.nudgeCmd++; return true; }
  );

  const range = opts.range === undefined
    ? { startContainer: node, commonAncestorContainer: node }
    : opts.range;

  api.restoreEditorFocus(el, range,
    opts.reassert === false ? { reassert: false } : undefined);

  const runTimers = (limit) => {
    let n = 0;
    while (timers.length && n++ < (limit || 25)) {
      const fn = timers.shift();
      try { fn(); } catch (e) { console.log('timer threw: ' + e.message); }
    }
  };

  return {
    calls, selState, node, detached, el, doc, timers, runTimers, api,
    get windowFocus() { return windowFocus; }
  };
}

{
  const live = runRestore({});
  check('R1 live range: focus + range restored, no end-anchor',
    live.calls.focus === 1 && live.calls.addRange === 2 && live.calls.anchored === 0 &&
      live.calls.nudge === 1,
    JSON.stringify(live.calls));

  const stale = runRestore({
    range: { startContainer: { isConnected: false }, commonAncestorContainer: { isConnected: false } }
  });
  check('R2 stale range: focus + caret anchored at end',
    stale.calls.focus === 1 && stale.calls.addRange === 0 && stale.calls.anchored === 2,
    JSON.stringify(stale.calls));

  const input = runRestore({ tagName: 'TEXTAREA', ce: false });
  check('R3 textarea: focus only (native selection state)',
    input.calls.focus === 1 && input.calls.addRange === 0 && input.calls.anchored === 0,
    JSON.stringify(input.calls));

  const detached = runRestore({ elConnected: false });
  check('R4 detached field: nothing happens', detached.calls.focus === 0, JSON.stringify(detached.calls));
}

{
  // The editor overwrote the selection asynchronously (removed node): the
  // scheduled re-assert must put the caret back into the field.
  const r = runRestore({});
  r.selState.anchorNode = r.detached;
  r.selState.ranges = [{ startContainer: r.detached }];
  r.runTimers();
  check('R5 async re-assert restores a caret the editor moved out',
    r.calls.addRange >= 2 && r.selState.anchorNode === r.node,
    'addRange=' + r.calls.addRange + ' anchor=' + (r.selState.anchorNode && r.selState.anchorNode.nodeName));

  // Every pass re-applies, even when the caret looks usable: the engine's own
  // re-assert can land at any moment inside the window (this is the late
  // clobber the loop exists for, and stopping at the first "ok" missed it).
  const keep = runRestore({});
  keep.selState.anchorNode = keep.node;
  keep.selState.ranges = [{ startContainer: keep.node }];
  keep.runTimers();
  check('R6 every pass re-applies the caret (late clobber wins nothing)',
    keep.calls.addRange === 5 && keep.calls.nudge === 4 && keep.calls.nudgeCmd === 1, 'addRange=' + keep.calls.addRange);

  // ...but a real user interaction stops the loop immediately.
  const touched = runRestore({});
  touched.selState.anchorNode = touched.detached;
  touched.selState.ranges = [{ startContainer: touched.detached }];
  touched.api.bumpUser();
  touched.runTimers();
  check('R6b user interaction cancels the re-assert loop',
    touched.calls.addRange === 2 && touched.calls.nudge === 1, 'addRange=' + touched.calls.addRange);

  // Focus moved on (e.g. the user clicked the subject line): leave it alone.
  const moved = runRestore({});
  moved.doc.activeElement = { tagName: 'INPUT', isConnected: true };
  moved.selState.anchorNode = moved.detached;
  moved.selState.ranges = [{ startContainer: moved.detached }];
  moved.runTimers();
  check('R7 re-assert is skipped once another field has the focus',
    moved.calls.addRange === 2 && moved.calls.nudge === 1, 'addRange=' + moved.calls.addRange);

  // The apply path rewrites the field and anchors the caret itself; its
  // staged framework write may still run, so no delayed selection change.
  const applied = runRestore({ reassert: false });
  check('R8 apply path schedules no re-assert',
    applied.timers.length === 0 && applied.calls.addRange === 2 && applied.calls.nudge === 1 &&
      applied.calls.nudgeCmd === 0,
    'timers=' + applied.timers.length);

  // An editing-host-level caret (anchorNode === field) is exactly the state
  // Gecko cannot keep: it must be re-anchored into a text node.
  const hostLevel = runRestore({});
  hostLevel.selState.anchorNode = hostLevel.el;
  hostLevel.selState.ranges = [{ startContainer: hostLevel.el }];
  hostLevel.runTimers();
  check('R9 an editing-host-level caret is re-anchored',
    hostLevel.calls.addRange >= 2 && hostLevel.selState.anchorNode === hostLevel.node,
    'addRange=' + hostLevel.calls.addRange);

  // If re-anchoring still leaves an unusable caret (stale range -> end
  // anchor), the second pass forces a real focus cycle to wake the editor.
  const cycle = runRestore({
    range: { startContainer: { isConnected: false }, commonAncestorContainer: { isConnected: false } }
  });
  cycle.runTimers();
  check('R10 second pass forces a focus cycle through the offscreen sink',
    cycle.calls.sinkFocus >= 1 && cycle.calls.sinkRemoved >= 1 && cycle.calls.anchored === 5,
    'sinkFocus=' + cycle.calls.sinkFocus + ' anchored=' + cycle.calls.anchored);

  // No createElement available (or it throws): the blur() fallback must run.
  const fallback = runRestore({
    noCreateElement: true,
    range: { startContainer: { isConnected: false }, commonAncestorContainer: { isConnected: false } }
  });
  fallback.runTimers();
  check('R11 focus cycle falls back to blur() without createElement',
    fallback.calls.blur >= 1 && fallback.calls.anchored === 5,
    'blur=' + fallback.calls.blur + ' anchored=' + fallback.calls.anchored);

  // An unfocused document paints no caret at all (Gecko's caret needs the
  // document focus). The restore must ask the window for it back.
  const unfocused = runRestore({ hasFocus: false });
  unfocused.runTimers();
  check('R12 an unfocused document gets window.focus()',
    unfocused.windowFocus >= 1, 'windowFocus=' + unfocused.windowFocus);

  const focused = runRestore({});
  focused.runTimers();
  check('R13 a focused document is left alone',
    focused.windowFocus === 0, 'windowFocus=' + focused.windowFocus);
}

// --- N: nudge (zero-width space edit) --------------------------------------
function runNudge(opts) {
  opts = opts || {};
  const calls = { insert: 0, removed: 0, addRange: 0, removeAll: 0, setStartAfter: 0, created: 0 };
  const zwsp = {
    nodeType: 3, isConnected: true, data: '\u200B',
    remove() { calls.removed++; }
  };
  const textNode = { nodeType: 3, isConnected: true, data: 'Hallo Welt' };
  const el = { nodeType: 1, textContent: 'Hallo Welt', contains(n) { return n === textNode || n === zwsp; } };
  const range = {
    startContainer: opts.outside ? { nodeType: 1, isConnected: true } : textNode,
    commonAncestorContainer: opts.outside ? { nodeType: 1, isConnected: true } : textNode,
    cloneRange() { return range; },
    collapse() {},
    insertNode(n) { calls.insert++; calls.inserted = n; }
  };
  const after = {
    setStartAfter(n) { calls.setStartAfter++; calls.afterNode = n; },
    collapse() {}
  };
  const selection = {
    rangeCount: opts.rangeCount === undefined ? 1 : opts.rangeCount,
    getRangeAt: () => range,
    removeAllRanges() { calls.removeAll++; },
    addRange(r) { calls.addRange++; calls.added = r; }
  };
  const doc = {
    createTextNode(d) { calls.created++; return zwsp; },
    createRange: () => after,
    execCommand(cmd, ui, value) {
      calls.commands = (calls.commands || []).concat([[cmd, value]]);
      if (cmd === 'insertText' && opts.insertWorks !== false) el.textContent += value;
      if (cmd === 'delete') el.textContent = el.textContent.slice(0, -1);
      return true;
    }
  };
  const factory = new Function('window', 'document', 'isNodeInDocument', `
    ${extractFn('nudgeEditorAtCaret')}
    ${extractFn('nudgeEditorByCommand')}
    return { nudgeEditorAtCaret, nudgeEditorByCommand };
  `);
  const api = factory({ getSelection: () => selection }, doc, () => true);
  const ok = api.nudgeEditorAtCaret(el, opts.range === undefined ? range : opts.range);
  return { ok, calls, zwsp, el, range, api, selection };
}

{
  const n = runNudge();
  check('N1 nudge inserts a zero-width space and removes it again',
    n.ok && n.calls.insert === 1 && n.calls.removed === 1 && n.calls.inserted === n.zwsp,
    JSON.stringify(n.calls));
  check('N2 selection is parked right behind the inserted node',
    n.calls.setStartAfter === 1 && n.calls.addRange === 1 && n.calls.afterNode === n.zwsp,
    'setStartAfter=' + n.calls.setStartAfter + ' addRange=' + n.calls.addRange);

  const outside = runNudge({ outside: true, rangeCount: 0 });
  check('N3 no usable caret -> no mutation', outside.ok === false && outside.calls.insert === 0,
    JSON.stringify(outside.calls));

  // The command path is the last resort: a real editor transaction.
  const c = runNudge();
  let applied = 0;
  const okCmd = c.api.nudgeEditorByCommand(c.el, () => { applied++; });
  const cmds = (c.calls.commands || []).map((x) => x[0]).join(',');
  check('N4 command nudge inserts and deletes the zero-width space',
    okCmd && applied === 1 && cmds === 'insertText,delete' &&
      (c.calls.commands[0][1] === '\u200B'),
    'commands=' + cmds + ' value=' + JSON.stringify(c.calls.commands && c.calls.commands[0][1]));

  // If the insert did not land (unsupported command, selection outside the
  // editor) the delete must NOT run: it would eat a real character.
  const noInsert = runNudge({ insertWorks: false });
  const okNo = noInsert.api.nudgeEditorByCommand(noInsert.el, () => {});
  const cmdsNo = (noInsert.calls.commands || []).map((x) => x[0]).join(',');
  check('N5 failed insert -> no delete (no character lost)',
    okNo === true && cmdsNo === 'insertText' && noInsert.el.textContent === 'Hallo Welt',
    'commands=' + cmdsNo + ' text=' + JSON.stringify(noInsert.el.textContent));
}

// --- D: dropUiSelection -----------------------------------------------------
function runDrop(opts) {
  opts = opts || {};
  const calls = opts.calls;
  const shadowRoot = { isShadowRoot: true };
  const host = { id: 'llm-assistant-ui-host', contains(n) { return n === host; } };
  const innerNode = { getRootNode: () => shadowRoot };
  const outsideNode = { getRootNode: () => ({ isShadowRoot: false }) };
  const selection = {
    rangeCount: opts.rangeCount === undefined ? 1 : opts.rangeCount,
    anchorNode: opts.anchorNode === undefined ? innerNode : opts.anchorNode,
    removeAllRanges() { calls.removeAll++; }
  };
  const factory = new Function('window', 'uiHost', 'uiRoot', `
    ${extractFn('dropUiSelection')}
    return dropUiSelection;
  `);
  factory({ getSelection: () => selection }, host, shadowRoot)();
  return calls;
}

{
  check('D1 selection inside the chat shadow root is cleared',
    runDrop({ calls: { removeAll: 0 } }).removeAll === 1);

  // Gecko may retarget a shadow selection to the UI host itself.
  const hostRetarget = (() => {
    const calls = { removeAll: 0 };
    const shadowRoot = { isShadowRoot: true };
    const host = { id: 'llm-assistant-ui-host', contains(n) { return n === host; } };
    const selection = { rangeCount: 1, anchorNode: host, removeAllRanges() { calls.removeAll++; } };
    const factory = new Function('window', 'uiHost', 'uiRoot', `
      ${extractFn('dropUiSelection')}
      return dropUiSelection;
    `);
    factory({ getSelection: () => selection }, host, shadowRoot)();
    return calls;
  })();
  check('D2 selection retargeted to the UI host is cleared', hostRetarget.removeAll === 1);

  const outside = runDrop({ calls: { removeAll: 0 }, anchorNode: { getRootNode: () => ({ isShadowRoot: false }) } });
  check('D3 selection outside the UI is left alone', outside.removeAll === 0);

  check('D4 no selection -> nothing happens',
    runDrop({ calls: { removeAll: 0 }, rangeCount: 0 }).removeAll === 0);
}

// --- W: closeChatWindow wiring ---------------------------------------------
function makeClose(opts) {
  opts = opts || {};
  const seen = [];
  const events = [];
  const moves = [];
  const factory = new Function('restoreEditorFocus', 'isNodeInDocument', 'showFloatingIcon', 'dropUiSelection', 'logCaretState',
    'uiFocusIsInside', 'moveFocusOutOfUi', `
    let currentRequestId = null;
    let cancelCurrentRequest = () => {};
    let chatWindow = null, chatMessages = [], chatStreamingBubble = null, chatStreamingText = "";
    let chatSendBtn = null, chatInputField = null;
    let pendingElement = null, activeInputElement = null, pendingCaretRange = null;
    ${extractFn('closeChatWindow')}
    return {
      close: closeChatWindow,
      set(s) {
        if ('pendingElement' in s) pendingElement = s.pendingElement;
        if ('activeInputElement' in s) activeInputElement = s.activeInputElement;
        if ('pendingCaretRange' in s) pendingCaretRange = s.pendingCaretRange;
        if ('chatWindow' in s) chatWindow = s.chatWindow;
        if ('chatMessages' in s) chatMessages = s.chatMessages;
      },
      state: () => ({ chatWindow, chatMessages, chatSendBtn, chatInputField, pendingCaretRange })
    };
  `);
  const api = factory(
    (el, range, opts) => seen.push({ el, range, opts }),
    () => true,
    () => {},
    () => events.push('drop'),
    () => {},
    () => opts.focusInUi !== false,
    (el, range) => { moves.push({ el, range }); events.push('move'); }
  );
  api.seen = seen;
  api.events = events;
  api.moves = moves;
  return api;
}

{
  const api = makeClose();
  const field = { id: 'compose-body' };
  const range = { id: 'caret' };
  let removed = false;
  api.set({
    pendingElement: field,
    pendingCaretRange: range,
    chatWindow: { remove() { removed = true; api.events.push('remove'); } },
    chatMessages: [{ role: 'user' }]
  });
  api.close();
  const st = api.state();
  check('W1 focus handed back to pendingElement with the remembered range',
    api.seen.length === 1 && api.seen[0].el === field && api.seen[0].range === range,
    JSON.stringify(api.seen.map(s => ({ el: s.el && s.el.id, range: s.range && s.range.id }))));
  check('W2 chat window torn down',
    removed === true && st.chatWindow === null && st.chatMessages.length === 0);
  check('W3 pending range cleared after use', st.pendingCaretRange === null);
  check('W4 UI selection dropped, then focus moved out, then overlay removed',
    api.events.join(',') === 'drop,move,remove', api.events.join(','));
  check('W7 focus is moved to the field with the remembered range while the input still exists',
    api.moves.length === 1 && api.moves[0].el === field && api.moves[0].range === range,
    JSON.stringify(api.moves.map(m => ({ el: m.el && m.el.id, range: m.range && m.range.id }))));
}

{
  const api = makeClose({ focusInUi: false });
  api.set({ pendingElement: { id: 'f' }, chatWindow: { remove() { api.events.push('remove'); } } });
  api.close();
  check('W8 focus outside the UI is left alone',
    api.moves.length === 0 && api.events.join(',') === 'drop,remove', api.events.join(','));
}

{
  const api = makeClose();
  api.set({ pendingElement: { id: 'f' }, pendingCaretRange: { id: 'stale' }, chatWindow: { remove() {} } });
  api.close({ reassert: false });
  check('W9 apply path moves focus without the stale open-time range',
    api.moves.length === 1 && api.moves[0].range === null,
    JSON.stringify(api.moves));
}

// --- M: moveFocusOutOfUi ----------------------------------------------------
// The real bug: removing the FOCUSED chat input lets Gecko drop the focus
// without a focus event for the editor -> no caret painted. The focus must
// leave the UI while the input still exists.
function runMove(opts) {
  const log = [];
  const uiHost = { id: 'host', blur() { log.push('host.blur'); } };
  const inner = { blur() { log.push('inner.blur'); state.innerActive = false; } };
  const state = { innerActive: true };
  const textNode = { nodeType: 3 };
  const field = {
    isContentEditable: true,
    contains: (n) => n === textNode,
    focus() { log.push('field.focus'); if (opts.focusWorks) state.innerActive = false; }
  };
  const uiRoot = { get activeElement() { return state.innerActive ? inner : null; } };
  const doc = { get activeElement() { return state.innerActive ? uiHost : field; } };
  const sel = {
    removeAllRanges() { log.push('sel.clear'); },
    addRange() { log.push('sel.add'); }
  };
  const fn = new Function('window', 'document', 'isNodeInDocument', 'uiHost', 'uiRoot', `
    ${extractFn('uiFocusIsInside')}
    ${extractFn('moveFocusOutOfUi')}
    return { moveFocusOutOfUi, uiFocusIsInside };
  `)({ getSelection: () => sel }, doc, () => true, uiHost, uiRoot);
  const before = fn.uiFocusIsInside();
  fn.moveFocusOutOfUi(field, opts.range === undefined
    ? { startContainer: textNode, commonAncestorContainer: textNode } : opts.range);
  return { log, before, after: fn.uiFocusIsInside() };
}

{
  const r = runMove({ focusWorks: true });
  check('M1 focus inside the UI is detected', r.before === true);
  check('M2 selection placed in the field BEFORE focusing it',
    r.log.slice(0, 3).join(',') === 'sel.clear,sel.add,field.focus', r.log.join(','));
  check('M3 focusable field: no blur needed, focus left the UI',
    r.after === false && !r.log.includes('inner.blur'), r.log.join(','));
}

{
  // designMode (Thunderbird): body.focus() does not take the focus away.
  const r = runMove({ focusWorks: false });
  check('M4 field.focus() a no-op -> inner UI element is blurred',
    r.log.includes('inner.blur') && r.after === false, r.log.join(','));
}

{
  const r = runMove({ focusWorks: true, range: null });
  check('M5 no range -> selection untouched', !r.log.includes('sel.add'), r.log.join(','));
}

{
  const api = makeClose();
  const field = { id: 'applied-field' };
  // applyLastResult clears pendingElement before closing
  api.set({ pendingElement: null, activeInputElement: field, chatWindow: { remove() {} } });
  api.close();
  check('W5 falls back to activeInputElement when pendingElement is cleared',
    api.seen.length === 1 && api.seen[0].el === field,
    JSON.stringify(api.seen.map(s => s.el && s.el.id)));
}

{
  const api = makeClose();
  api.set({ pendingElement: { id: 'f' }, chatWindow: { remove() {} } });
  api.close({ reassert: false });
  check('W6 close options reach restoreEditorFocus (apply path)',
    !!(api.seen[0] && api.seen[0].opts && api.seen[0].opts.reassert === false),
    JSON.stringify(api.seen[0] && api.seen[0].opts));
}

console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILURES');
process.exit(fails === 0 ? 0 : 1);
