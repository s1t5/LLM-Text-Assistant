// Verifies the free-prompt focus/caret restore (v1.6.6, Thunderbird bug):
// opening the chat window focuses its input; closing it used to leave the
// document without an editable target — in Thunderbird document.body IS the
// compose body, so the mail could not be typed into until the user clicked
// it again.
//
// Slices the real functions out of content.js:
//   captureCaretRange  — remembers the caret inside the edited field
//   restoreEditorFocus — focuses the field again and re-anchors the caret
//   closeChatWindow    — must call restoreEditorFocus with the field it was
//                        opened from (pendingElement, else activeInputElement)
//
// Groups:
//   C — captureCaretRange: inside / outside / no selection
//   R — restoreEditorFocus: live range, stale range -> end, input/textarea,
//       detached element
//   W — closeChatWindow wiring: pendingElement, activeInputElement fallback,
//       teardown of the window state

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

  const run = (range, rangeCount) => {
    const win = {
      getSelection: () => ({
        rangeCount: rangeCount === undefined ? (range ? 1 : 0) : rangeCount,
        getRangeAt: () => range
      })
    };
    const fn = new Function('window', extractFn('captureCaretRange') + '\nreturn captureCaretRange;')(win);
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
}

// --- R: restoreEditorFocus --------------------------------------------------
function runRestore(opts) {
  const calls = { focus: 0, addRange: 0, anchored: 0 };
  const node = { isConnected: opts.nodeConnected !== false };
  const el = {
    tagName: opts.tagName || 'DIV',
    isContentEditable: opts.ce !== false,
    isConnected: opts.elConnected !== false,
    contains(n) {
      return n === node ||
        !!(opts.range && n === opts.range.commonAncestorContainer);
    },
    focus() { calls.focus++; }
  };
  const win = {
    getSelection: () => ({ removeAllRanges() {}, addRange() { calls.addRange++; } })
  };
  const fn = new Function('window', 'isNodeInDocument', 'anchorCaretAtEnd',
    extractFn('restoreEditorFocus') + '\nreturn restoreEditorFocus;')(
    win, (n) => !!(n && n.isConnected), () => { calls.anchored++; }
  );
  fn(el, opts.range === undefined ? null : opts.range);
  return calls;
}

{
  const live = runRestore({
    range: { startContainer: { isConnected: true }, commonAncestorContainer: { isConnected: true } }
  });
  check('R1 live range: focus + range restored, no end-anchor',
    live.focus === 1 && live.addRange === 1 && live.anchored === 0, JSON.stringify(live));

  const stale = runRestore({
    range: { startContainer: { isConnected: false }, commonAncestorContainer: { isConnected: false } }
  });
  check('R2 stale range: focus + caret anchored at end',
    stale.focus === 1 && stale.addRange === 0 && stale.anchored === 1, JSON.stringify(stale));

  const input = runRestore({ tagName: 'TEXTAREA', ce: false });
  check('R3 textarea: focus only (native selection state)',
    input.focus === 1 && input.addRange === 0 && input.anchored === 0, JSON.stringify(input));

  const detached = runRestore({ elConnected: false });
  check('R4 detached field: nothing happens', detached.focus === 0, JSON.stringify(detached));
}

// --- W: closeChatWindow wiring ---------------------------------------------
function makeClose() {
  const seen = [];
  const factory = new Function('restoreEditorFocus', 'isNodeInDocument', 'showFloatingIcon', `
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
  const api = factory((el, range) => seen.push({ el, range }), () => true, () => {});
  api.seen = seen;
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
    chatWindow: { remove() { removed = true; } },
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
}

{
  const api = makeClose();
  const field = { id: 'applied-field' };
  // applyLastResult clears pendingElement before closing
  api.set({ pendingElement: null, activeInputElement: field, chatWindow: { remove() {} } });
  api.close();
  check('W4 falls back to activeInputElement when pendingElement is cleared',
    api.seen.length === 1 && api.seen[0].el === field,
    JSON.stringify(api.seen.map(s => s.el && s.el.id)));
}

console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILURES');
process.exit(fails === 0 ? 0 : 1);
