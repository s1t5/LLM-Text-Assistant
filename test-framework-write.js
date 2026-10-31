// Verifies the framework write chain (scheduleFrameworkPasteWrite) against an
// ASYNCHRONOUS editing engine — the Firefox behaviour that broke whole-field
// replacement on Lexical/Reddit (v1.6.6).
//
// The bug: execCommand applies the DOM mutation in a LATER task in Firefox.
// The old chain verified synchronously, always saw the old text, and ran the
// repair dance (delete + re-insert) on top of a write that was already
// correct — Reddit ended up with stacked copies ("ol!").
//
// Pattern: slices the REAL function out of content.js and drives it with a
// fake editor. `pasteWriteToken` lives in the factory closure so the test can
// bump it like a new action would.
//
// Groups:
//   A — async engine, write lands: exactly ONE write, NO delete, correct text
//   B — engine reverts the DOM write (CKEditor/Teams): paste stage recovers
//   C — engine reverts AND cannot paste (Firefox ClipboardEvent): settled
//       pipeline write recovers, no infinite retry
//   D — token bump cancels a scheduled chain (no write after cancel)

const fs = require('fs');
// Optional path argument (defaults to the repo checkout, never an absolute
// host path — CI runs from a different directory).
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

const fnSrc = extractFn('scheduleFrameworkPasteWrite');

// Builds one isolated run: fresh closure for pasteWriteToken + fake engine.
function makeEnv(opts) {
  const o = Object.assign({
    initial: 'Das ist cool',
    asyncApply: true,     // Firefox: mutation lands in a later task
    revertAfterMs: 0,     // >0: engine throws the DOM write away
    pasteWorks: true,
    applyDelayMs: 5
  }, opts || {});

  const log = { writes: [], deletes: 0, pastes: [], textAt: [] };
  const el = {
    tagName: 'DIV',
    isContentEditable: true,
    isConnected: true,
    text: o.initial,
    focused: false,
    contains() { return true; },
    focus() { this.focused = true; }
  };
  const original = o.initial;
  let revertTimer = null;

  // `kind` models the editor polarity: a pipeline (execCommand) write is
  // consumed into the DOM but NOT into the model of a CKEditor-style editor,
  // which reverts it on its next render; a paste write goes into the model
  // and sticks.
  const apply = (value, kind) => {
    if (o.asyncApply) {
      setTimeout(() => { el.text = value; }, o.applyDelayMs);
    } else {
      el.text = value;
    }
    if (o.revertAfterMs > 0 && kind === 'pipeline') {
      clearTimeout(revertTimer);
      revertTimer = setTimeout(() => { el.text = original; }, o.revertAfterMs);
    }
  };

  const env = {
    getElementFullText: (e) => e.text,
    isNodeInDocument: (e) => !!e.isConnected,
    rangeIsWithin: () => true,
    execInsertTextCE: (e, range, text) => { log.writes.push(text); apply(text, 'pipeline'); return true; },
    // The OLD stage 0 (pre-v1.6.6): write, read back in the same task, and
    // repair on mismatch. With an async engine the read-back always sees the
    // old text, so it always deletes + re-inserts — the defect under test.
    execSetCEText: (e, text) => {
      log.writes.push(text);
      apply(text, 'pipeline');
      if (e.text !== text) {
        log.deletes++;
        apply('', 'pipeline');
        log.writes.push(text);
        apply(text, 'pipeline');
        return e.text === text;
      }
      return true;
    },
    execDeleteCEContents: () => { log.deletes++; apply('', 'pipeline'); return true; },
    dispatchPasteCE: (e, text) => {
      if (!o.pasteWorks) return false;
      log.pastes.push(text);
      apply(text, 'paste');
      return true;
    },
    document: {
      createRange: () => ({ selectNodeContents() {}, collapse() {} })
    },
    window: {
      getSelection: () => ({ removeAllRanges() {}, addRange() {} })
    },
    console: { warn: () => {}, log: () => {}, error: () => {} }
  };

  const factory = new Function(
    'getElementFullText', 'isNodeInDocument', 'rangeIsWithin',
    'execInsertTextCE', 'execSetCEText', 'execDeleteCEContents', 'dispatchPasteCE',
    'document', 'window', 'console',
    'let pasteWriteToken = 0;\n' + fnSrc +
    '\nreturn { run: scheduleFrameworkPasteWrite, bump: () => { pasteWriteToken++; }, token: () => pasteWriteToken };'
  );

  const api = factory(
    env.getElementFullText, env.isNodeInDocument, env.rangeIsWithin,
    env.execInsertTextCE, env.execSetCEText, env.execDeleteCEContents, env.dispatchPasteCE,
    env.document, env.window, env.console
  );

  return { el, log, api, original };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // --- A: async engine (Firefox), write lands ------------------------------
  {
    const { el, log, api } = makeEnv({ asyncApply: true });
    api.run(el, "That's cool!", null, 'Das ist cool', 0);
    await sleep(1400);
    check('A1 async engine: field holds the result',
      el.text === "That's cool!", JSON.stringify(el.text));
    check('A2 exactly one pipeline write (no repair dance)',
      log.writes.length === 1, 'writes=' + log.writes.length);
    check('A3 no delete was issued', log.deletes === 0, 'deletes=' + log.deletes);
  }

  // --- B: engine reverts the DOM write, paste available (CKEditor) ---------
  {
    const { el, log, api } = makeEnv({ asyncApply: true, revertAfterMs: 120, pasteWorks: true });
    api.run(el, "That's cool!", null, 'Das ist cool', 0);
    await sleep(2600);
    check('B1 reverting engine: result survives (paste stage)',
      el.text === "That's cool!", JSON.stringify(el.text));
    check('B2 paste stage was used', log.pastes.length >= 1, 'pastes=' + log.pastes.length);
  }

  // --- C: Firefox polarity — async engine, no ClipboardEvent paste --------
  {
    const { el, log, api } = makeEnv({ asyncApply: true, revertAfterMs: 0, pasteWorks: false });
    api.run(el, "That's cool!", null, 'Das ist cool', 0);
    await sleep(1400);
    check('C1 no-paste engine (Firefox): result survives',
      el.text === "That's cool!", JSON.stringify(el.text));
    check('C2 one write was enough (no paste, no delete)',
      log.writes.length === 1 && log.pastes.length === 0 && log.deletes === 0,
      'writes=' + log.writes.length + ' pastes=' + log.pastes.length + ' deletes=' + log.deletes);
  }

  // --- E: reverting engine AND no paste — chain must give up, not loop ----
  {
    const { el, log, api } = makeEnv({ asyncApply: true, revertAfterMs: 120, pasteWorks: false });
    api.run(el, "That's cool!", null, 'Das ist cool', 0);
    await sleep(3600);
    check('E1 chain terminates (bounded writes)', log.writes.length <= 4,
      'writes=' + log.writes.length);
    check('E2 field left as-is, not stacked with copies',
      el.text === 'Das ist cool', JSON.stringify(el.text));
  }

  // --- D: token bump cancels the chain ------------------------------------
  {
    const { el, log, api } = makeEnv({ asyncApply: true });
    api.run(el, "That's cool!", null, 'Das ist cool', 0);
    api.bump(); // a new action / undo started
    await sleep(1400);
    check('D1 cancelled chain wrote nothing', log.writes.length === 0,
      'writes=' + log.writes.length);
    check('D2 field untouched', el.text === 'Das ist cool', JSON.stringify(el.text));
  }

  console.log(fails === 0 ? 'ALL PASS' : fails + ' FAILURES');
  process.exit(fails === 0 ? 0 : 1);
})();
