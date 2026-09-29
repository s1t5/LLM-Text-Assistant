// Verifies the free-prompt routing fix in content.js (Thunderbird compose
// toolbar) and the shadow-DOM focus resolution (Reddit/web components):
//   1. resolveFreePromptTarget — priority for which field the chat window
//      attaches to (live active element wins, then the remembered field,
//      then null — openFreePromptChat() declines, no replacement is run)
//   2. resolveEditingTarget — Shadow-DOM-aware "which field has focus":
//      when focus sits inside an open shadow root,
//      document.activeElement retargets to the shadow host; the resolver
//      must descend through sr.activeElement to the real editor
//   3. findTextInputOnPath — walks a focusin composedPath() host→leaf and
//      returns the first text input (covers closed shadow roots, where
//      activeElement inside the root is invisible)
//   4. the contextMenuProcess handler answers textAction 'freePrompt' with
//      the chat-window path BEFORE the replacement pipeline — the bug was
//      that Thunderbird's compose toolbar routes freePrompt through
//      contextMenuProcess, so the mail body got replaced instead of a chat
//      window opening (the browser context menu never offers freePrompt).
// Pattern: slices the REAL functions out of content.js (same approach as
// test-ce-finalize.js) plus a structural check on the message handler.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/content.js', 'utf8');

function extractFn(name) {
  const start = src.indexOf('function ' + name);
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

// --- 1) resolveFreePromptTarget ------------------------------------------
const isTextInput = new Function(extractFn('isTextInput') + '\nreturn isTextInput;')();
const resolve = new Function('isTextInput',
  extractFn('resolveFreePromptTarget') + '\nreturn resolveFreePromptTarget;')(isTextInput);

const ceBody = { tagName: 'DIV', isContentEditable: true };
const textarea = { tagName: 'TEXTAREA' };
const subjectInput = { tagName: 'INPUT', type: 'text' };
const body = { tagName: 'BODY' };           // what document.activeElement is
const button = { tagName: 'INPUT', type: 'button' }; // not a text input

// The toolbar-popup case: focus sits outside the compose document
check('A: <body> live -> remembered compose body wins',
  resolve(body, ceBody) === ceBody);
check('B: <body> live + subject input remembered',
  resolve(body, subjectInput) === subjectInput);
check('C: live text field wins over remembered field',
  resolve(ceBody, subjectInput) === ceBody);
check('D: textarea live beats remembered body',
  resolve(textarea, ceBody) === textarea);
check('E: nothing usable -> null (chat declines, no replacement)',
  resolve(body, null) === null);
check('F: non-text input neither live nor remembered -> null',
  resolve(button, button) === null);
check('G: null live + null remembered -> null',
  resolve(null, null) === null);

// --- 2) handler structure: freePrompt must short-circuit BEFORE the
//        replacement pipeline inside the contextMenuProcess branch ---------
const branchStart = src.indexOf('"contextMenuProcess"');
if (branchStart < 0) { console.error('FAIL: contextMenuProcess branch not found'); process.exit(2); }
const guardIdx = src.indexOf('if (request.textAction === "freePrompt")', branchStart);
const pipelineIdx = src.indexOf('handleContextMenuProcess(', branchStart);
check('S1: freePrompt guard exists in the contextMenuProcess branch',
  guardIdx > branchStart && guardIdx < pipelineIdx,
  'guard@' + guardIdx + ' pipeline@' + pipelineIdx);
const openIdx = src.indexOf('openFreePromptChat()', guardIdx);
check('S2: guard opens the chat window before the pipeline call',
  openIdx > guardIdx && openIdx < pipelineIdx,
  'open@' + openIdx + ' pipeline@' + pipelineIdx);
const resumeIdx = src.indexOf('uiSuspended = false', branchStart);
check('S3: guard resumes a suspended UI (cancelled send)',
  resumeIdx > branchStart && resumeIdx < pipelineIdx);

// --- 3) resolveEditingTarget: shadow-DOM focus resolution ------------------
const resolveEditingTargetFactory = new Function('document', 'isTextInput',
  extractFn('resolveEditingTarget') + '\nreturn resolveEditingTarget;');
// factory(doc, isTextInput) returns the inner function bound to that doc —
// invoke it to get the resolution result.
const resolveEditingTarget = (doc) => resolveEditingTargetFactory(doc, isTextInput)();

const taField = { tagName: 'TEXTAREA' };
const ceField = { tagName: 'DIV', isContentEditable: true };
const shadowHost = { tagName: 'SHREDDIT-COMPOSER' };
const innerHost = { tagName: 'FACEPLATE-BASERICHTEXTEDITOR', shadowRoot: null };
const document0 = { activeElement: body };

// open shadow root: host.activeElement points at the inner editor
shadowHost.shadowRoot = { activeElement: ceField };
check('T1: focus inside open shadow root -> real editor found',
  resolveEditingTarget({ activeElement: shadowHost }) === ceField);
// nested shadow roots: host -> inner host -> textarea
innerHost.shadowRoot = { activeElement: taField };
shadowHost.shadowRoot = { activeElement: innerHost };
check('T2: nested shadow roots -> deepest editor found',
  resolveEditingTarget({ activeElement: shadowHost }) === taField);
// host whose shadow root has no active element -> nothing usable
shadowHost.shadowRoot = { activeElement: null };
check('T3: shadow root without focus -> null',
  resolveEditingTarget({ activeElement: shadowHost }) === null);
// plain light-DOM field
check('T4: light-DOM textarea -> found directly',
  resolveEditingTarget({ activeElement: taField }) === taField);
// body focused -> null
check('T5: <body> focused -> null',
  resolveEditingTarget({ activeElement: body }) === null);
// loop guard: self-referencing shadow root must not hang
const cyclic = { tagName: 'HOST', shadowRoot: null };
cyclic.shadowRoot = { activeElement: cyclic };
let resolvedCyclic = 'no-throw';
try { resolveEditingTarget({ activeElement: cyclic }); } catch (e) { resolvedCyclic = 'threw'; }
check('T6: cyclic shadow chain terminates (guard)', resolvedCyclic === 'no-throw');
// null document.activeElement
check('T7: null activeElement -> null',
  resolveEditingTarget({ activeElement: null }) === null);

// --- 4) findTextInputOnPath: focusin composedPath walker -------------------
const findTextInputOnPath = new Function('isTextInput',
  extractFn('findTextInputOnPath') + '\nreturn findTextInputOnPath;')(isTextInput);

const leafEditor = { tagName: 'DIV', isContentEditable: true };
const hostEl = { tagName: 'SHREDDIT-COMPOSER' };
const root = { tagName: 'DIV' };
// composedPath is leaf-first
check('U1: editor deep in composed path found',
  findTextInputOnPath([leafEditor, hostEl, root, document0]) === leafEditor);
check('U2: no input on path -> null',
  findTextInputOnPath([root, document0]) === null);
check('U3: null entries tolerated',
  findTextInputOnPath([null, undefined, taField]) === taField);
check('U4: empty path -> null', findTextInputOnPath([]) === null);

// --- 5) structural: init registers focusin, no MutationObserver scan --------
const initIdx = src.indexOf('function init()');
const focusinIdx = src.indexOf("document.addEventListener('focusin', handleFocusIn, true)");
check('V1: init registers the delegated focusin listener',
  focusinIdx > initIdx && focusinIdx !== -1);
check('V2: MutationObserver scan removed from content.js',
  src.indexOf('new MutationObserver') === -1);
check('V3: querySelectorAll input scan removed',
  src.indexOf("querySelectorAll('input, textarea") === -1);
check('V4: no document.contains CALL remains (shadow-blind)',
  !/[^\/\s]document\.contains\(/.test(src));

console.log(fails === 0 ? '\nALL TESTS PASSED' : '\n' + fails + ' FAILURES');
process.exit(fails ? 1 : 0);
