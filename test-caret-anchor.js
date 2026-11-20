// Verifies the caret anchor after a whole-field write (v1.7.3, Thunderbird):
// the compose body IS document.body and the add-in's UI host is one of its
// children. A pipeline write (select-all + insertText) leaves the DOM caret at
// the EDITING-HOST level, and with the host re-appended as the last child the
// caret lands behind it. Gecko cannot keep a caret there and moves it to the
// start of the mail on the next keystroke ("the caret jumps to the text start
// and typing puts it right back").
//
// Slices the real functions out of content.js:
//   isUiNode            — the extension's own UI host
//   lastTextNodeIn      — deepest last text node, skipping the UI
//   anchorCaretAtEnd    — caret into the last text node of the content
//   settleCaretAfterPipelineWrite — deferred fix-up, user interaction wins
//
// Groups:
//   A — anchorCaretAtEnd: text child, nested block, UI host last, empty field,
//       trailing <br>/empty paragraph (a result that ends with a line break)
//   S — settleCaretAfterPipelineWrite: fires on the result, steps aside for
//       user interaction, lost focus or an edited field

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

// --- fake DOM ---------------------------------------------------------------
function txt(s) {
  return { nodeType: 3, text: s, length: s.length, parentNode: null, previousSibling: null };
}
function el(id, children) {
  const node = {
    nodeType: 1,
    id: id || '',
    childNodes: children || [],
    parentNode: null,
    previousSibling: null,
    get lastChild() { return this.childNodes.length ? this.childNodes[this.childNodes.length - 1] : null; }
  };
  node.childNodes.forEach((c, i) => {
    c.parentNode = node;
    c.previousSibling = i > 0 ? node.childNodes[i - 1] : null;
  });
  return node;
}

function runAnchor(rootChildren, uiNode) {
  // The Range keeps its own position; the selection only holds it after
  // addRange(). (A shared state object would be wiped by removeAllRanges().)
  const pos = { node: null, offset: null, after: null, collapsed: false };
  const range = {
    setStart(n, o) { pos.node = n; pos.offset = o; },
    setStartAfter(n) { pos.after = n; pos.node = n.parentNode; },
    collapse() { pos.collapsed = true; },
    get startContainer() { return pos.node; },
    get startOffset() { return pos.offset; }
  };
  const state = { startNode: null, startOffset: null, afterNode: null, collapsed: false, rangeCount: 0 };
  const selection = {
    removeAllRanges() {
      state.startNode = null; state.startOffset = null;
      state.afterNode = null; state.rangeCount = 0;
    },
    addRange(r) {
      state.startNode = r.startContainer;
      state.startOffset = r.startOffset;
      state.afterNode = pos.after;
      state.collapsed = pos.collapsed;
      state.rangeCount = 1;
    }
  };
  const factory = new Function('window', 'document', 'uiHost', `
    ${extractFn('isUiNode')}
    ${extractFn('lastTextNodeIn')}
    ${extractFn('anchorCaretAtEnd')}
    return { anchorCaretAtEnd, isUiNode, lastTextNodeIn };
  `);
  const api = factory(
    { getSelection: () => selection },
    { createRange: () => range },
    uiNode || null
  );
  const root = el('body', rootChildren);
  api.anchorCaretAtEnd(root);
  return { state, root, api };
}

// --- A: anchorCaretAtEnd ----------------------------------------------------
{
  const t = txt('Hallo Welt');
  const r = runAnchor([t]);
  check('A1 text child: caret at the end of the text node',
    r.state.startNode === t && r.state.startOffset === 10 && r.state.collapsed,
    'offset=' + r.state.startOffset);

  const inner = txt('Absatz');
  const p = el('p', [inner]);
  const r2 = runAnchor([p]);
  check('A2 nested block: caret inside the last text node, not after the block',
    r2.state.startNode === inner && r2.state.startOffset === 6 && !r2.state.afterNode,
    'node=' + (r2.state.startNode && r2.state.startNode.nodeType) + ' offset=' + r2.state.startOffset);

  const ui = el('llm-assistant-ui-host', []);
  const inner3 = txt('Ergebnis');
  const p3 = el('p', [inner3]);
  const r3 = runAnchor([p3, ui], ui);
  check('A3 UI host last: caret in the mail text, never behind the host',
    r3.state.startNode === inner3 && r3.state.startOffset === 8 && r3.state.afterNode === null,
    'afterNode=' + (r3.state.afterNode && r3.state.afterNode.id));

  const uiOnly = el('llm-assistant-ui-host', []);
  const r4 = runAnchor([uiOnly], uiOnly);
  check('A4 only the UI host: caret at the editing host start',
    r4.state.startNode === r4.root && r4.state.startOffset === 0);

  const r5 = runAnchor([]);
  check('A5 empty field: caret at offset 0', r5.state.startNode === r5.root && r5.state.startOffset === 0);

  const emptyP = el('p', []);
  const r6 = runAnchor([emptyP]);
  check('A6 no text at all: caret at the editing host start',
    r6.state.startNode === r6.root && r6.state.startOffset === 0 && !r6.state.afterNode);

  const deep = txt('tief');
  const r7 = runAnchor([el('div', [el('p', [deep])])]);
  check('A7 nested blocks: deepest last text node wins',
    r7.state.startNode === deep && r7.state.startOffset === 4);

  // A result that ends with a line break leaves a trailing <br> (soft break)
  // or an empty paragraph behind. Anchoring behind those nodes puts the caret
  // at the EDITING-HOST level, which Gecko normalizes to the start of the mail
  // on the next keystroke — the exact symptom the anchor exists to prevent.
  const trailingText = txt('Hallo');
  const br = el('br', []);
  const r8 = runAnchor([trailingText, br]);
  check('A8 trailing <br>: caret in the last text node, not behind the break',
    r8.state.startNode === trailingText && r8.state.startOffset === 5 && !r8.state.afterNode,
    'node=' + (r8.state.startNode && r8.state.startNode.nodeType) + ' offset=' + r8.state.startOffset);

  const pText = txt('Absatz');
  const trailingEmptyBlock = el('div', [el('br', [])]);
  const r9 = runAnchor([el('p', [pText]), trailingEmptyBlock]);
  check('A9 trailing empty paragraph: caret in the last text node before it',
    r9.state.startNode === pText && r9.state.startOffset === 6 && !r9.state.afterNode,
    'node=' + (r9.state.startNode && r9.state.startNode.nodeType) + ' offset=' + r9.state.startOffset);

  const emptyText = txt('');
  const realText = txt('Rest');
  const r10 = runAnchor([realText, emptyText]);
  check('A10 trailing empty text node: skipped, caret in the previous text',
    r10.state.startNode === realText && r10.state.startOffset === 4 && !r10.state.afterNode);

  const inBlockText = txt('Zeile');
  const blockWithBreak = el('div', [inBlockText, el('br', [])]);
  const r11 = runAnchor([blockWithBreak]);
  check('A11 last block ends with <br>: caret at the end of its text',
    r11.state.startNode === inBlockText && r11.state.startOffset === 5 && !r11.state.afterNode);
}

// --- S: settleCaretAfterPipelineWrite --------------------------------------
function runSettle(opts) {
  opts = opts || {};
  const calls = { anchor: 0, checks: 0, logs: [] };
  const timers = [];
  const factory = new Function(
    'isNodeInDocument', 'fieldOwnsFocus', 'readBackMatches', 'anchorCaretAtEnd',
    'logCaretState', 'requestAnimationFrame', 'setTimeout', `
    let userInteractToken = 0;
    ${extractFn('settleCaretAfterPipelineWrite')}
    return {
      settle: settleCaretAfterPipelineWrite,
      bump() { userInteractToken++; }
    };
  `);
  const api = factory(
    () => opts.connected !== false,
    () => opts.focused !== false,
    () => { calls.checks++; return opts.matches !== false; },
    () => { calls.anchor++; },
    (tag) => { calls.logs.push(tag); },
    (cb) => { timers.push(cb); return timers.length; },
    (cb) => { timers.push(cb); return timers.length; }
  );
  api.settle({ id: 'body' }, 'Ergebnis');
  const runTimers = () => {
    let n = 0;
    while (timers.length && n++ < 30) {
      try { timers.shift()(); } catch (e) { console.log('timer threw: ' + e.message); }
    }
  };
  return { calls, runTimers, api, timers };
}

{
  const s = runSettle({});
  s.runTimers();
  check('S1 caret fix-up anchors once the result is in the field',
    s.calls.anchor >= 1 && s.calls.checks >= 1,
    'anchor=' + s.calls.anchor + ' checks=' + s.calls.checks);

  const u = runSettle({});
  u.api.bump(); // user clicked or typed before the fix-up ran
  u.runTimers();
  check('S2 a user interaction before the fix-up wins', u.calls.anchor === 0);

  const f = runSettle({ focused: false });
  f.runTimers();
  check('S3 no fix-up when another field has the focus', f.calls.anchor === 0);

  const m = runSettle({ matches: false });
  m.runTimers();
  check('S4 no fix-up when the field no longer shows the result', m.calls.anchor === 0);

  const d = runSettle({ connected: false });
  d.runTimers();
  check('S5 no fix-up for a detached field', d.calls.anchor === 0);

  // Diagnostic: one compact console line per write, naming the decision, so a
  // Thunderbird caret report can be read instead of guessed.
  const l = runSettle({});
  l.runTimers();
  check('S6 one log line per write, tagged with the decision',
    l.calls.logs.length === 1 && /:anchored$/.test(l.calls.logs[0]),
    'logs=' + JSON.stringify(l.calls.logs));

  const lu = runSettle({});
  lu.api.bump();
  lu.runTimers();
  check('S7 the log names a user interaction that cancelled the fix-up',
    lu.calls.logs.length === 1 && /:user$/.test(lu.calls.logs[0]),
    'logs=' + JSON.stringify(lu.calls.logs));
}

console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILURES');
process.exit(fails === 0 ? 0 : 1);
