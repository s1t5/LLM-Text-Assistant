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
  const calls = { focus: 0, addRange: 0, anchored: 0, removeAll: 0, blur: 0, sinkFocus: 0, sinkRemoved: 0 };
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
    body: opts.body || el
  };
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
    'requestAnimationFrame', 'setTimeout', `
    ${extractFn('caretIsUsable')}
    ${extractFn('fieldOwnsFocus')}
    ${extractFn('restoreEditorFocus')}
    return { restoreEditorFocus, caretIsUsable, fieldOwnsFocus };
  `);
  const api = factory(
    { getSelection: () => selection },
    doc,
    (n) => !!(n && n.isConnected),
    () => { calls.anchored++; selState.anchorNode = el; selState.ranges = [{ startContainer: el }]; },
    () => {},
    (cb) => { timers.push(cb); return timers.length; },
    (cb) => { timers.push(cb); return timers.length; }
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

  return { calls, selState, node, detached, el, doc, timers, runTimers, api };
}

{
  const live = runRestore({});
  check('R1 live range: focus + range restored, no end-anchor',
    live.calls.focus === 1 && live.calls.addRange === 1 && live.calls.anchored === 0,
    JSON.stringify(live.calls));

  const stale = runRestore({
    range: { startContainer: { isConnected: false }, commonAncestorContainer: { isConnected: false } }
  });
  check('R2 stale range: focus + caret anchored at end',
    stale.calls.focus === 1 && stale.calls.addRange === 0 && stale.calls.anchored === 1,
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
    r.calls.addRange === 2 && r.selState.anchorNode === r.node,
    'addRange=' + r.calls.addRange + ' anchor=' + (r.selState.anchorNode && r.selState.anchorNode.nodeName));

  // A caret that is already inside the field wins — a click or keystroke in
  // the meantime must never be undone.
  const keep = runRestore({});
  keep.selState.anchorNode = keep.node;
  keep.selState.ranges = [{ startContainer: keep.node }];
  keep.runTimers();
  check('R6 re-assert never fights a caret that is already in the field',
    keep.calls.addRange === 1, 'addRange=' + keep.calls.addRange);

  // Focus moved on (e.g. the user clicked the subject line): leave it alone.
  const moved = runRestore({});
  moved.doc.activeElement = { tagName: 'INPUT', isConnected: true };
  moved.selState.anchorNode = moved.detached;
  moved.selState.ranges = [{ startContainer: moved.detached }];
  moved.runTimers();
  check('R7 re-assert is skipped once another field has the focus',
    moved.calls.addRange === 1, 'addRange=' + moved.calls.addRange);

  // The apply path rewrites the field and anchors the caret itself; its
  // staged framework write may still run, so no delayed selection change.
  const applied = runRestore({ reassert: false });
  check('R8 apply path schedules no re-assert',
    applied.timers.length === 0 && applied.calls.addRange === 1,
    'timers=' + applied.timers.length);

  // An editing-host-level caret (anchorNode === field) is exactly the state
  // Gecko cannot keep: it must be re-anchored into a text node.
  const hostLevel = runRestore({});
  hostLevel.selState.anchorNode = hostLevel.el;
  hostLevel.selState.ranges = [{ startContainer: hostLevel.el }];
  hostLevel.runTimers();
  check('R9 an editing-host-level caret is re-anchored',
    hostLevel.calls.addRange === 2 && hostLevel.selState.anchorNode === hostLevel.node,
    'addRange=' + hostLevel.calls.addRange);

  // If re-anchoring still leaves an unusable caret (stale range -> end
  // anchor), the second pass forces a real focus cycle to wake the editor.
  const cycle = runRestore({
    range: { startContainer: { isConnected: false }, commonAncestorContainer: { isConnected: false } }
  });
  cycle.runTimers();
  check('R10 second pass forces a focus cycle through the offscreen sink',
    cycle.calls.sinkFocus >= 1 && cycle.calls.sinkRemoved >= 1 && cycle.calls.anchored >= 3,
    'sinkFocus=' + cycle.calls.sinkFocus + ' anchored=' + cycle.calls.anchored);

  // No createElement available (or it throws): the blur() fallback must run.
  const fallback = runRestore({
    noCreateElement: true,
    range: { startContainer: { isConnected: false }, commonAncestorContainer: { isConnected: false } }
  });
  fallback.runTimers();
  check('R11 focus cycle falls back to blur() without createElement',
    fallback.calls.blur >= 1 && fallback.calls.anchored >= 3,
    'blur=' + fallback.calls.blur + ' anchored=' + fallback.calls.anchored);
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
function makeClose() {
  const seen = [];
  const events = [];
  const factory = new Function('restoreEditorFocus', 'isNodeInDocument', 'showFloatingIcon', 'dropUiSelection', 'logCaretState', `
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
    () => {}
  );
  api.seen = seen;
  api.events = events;
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
  check('W4 UI selection is dropped before the overlay is removed',
    api.events.join(',') === 'drop,remove', api.events.join(','));
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
