// Verifies the free-prompt routing fix in content.js (Thunderbird compose
// toolbar):
//   1. resolveFreePromptTarget — priority for which field the chat window
//      attaches to (live active element wins, then the remembered field,
//      then null — openFreePromptChat() declines, no replacement is run)
//   2. the contextMenuProcess handler answers textAction 'freePrompt' with
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

console.log(fails === 0 ? '\nALL TESTS PASSED' : '\n' + fails + ' FAILURES');
process.exit(fails ? 1 : 0);
