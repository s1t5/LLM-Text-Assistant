// Verifies the execInsertTextCE multiline logic that content.js now uses.
// Simulates the execCommand behavior of real engines per spec/vendor docs:
//  - Chrome/Blink:  insertText "\n" → plain text node "\n" (NOT rendered as break in
//                   most contenteditables), insertLineBreak → <br>, insertParagraph → <div>/<p> split
//  - Gecko (TB):    insertText "\n" → plain text "\n", insertLineBreak → <br>,
//                   insertParagraph → paragraph split (mail composer splits paragraphs)
//  - WebKit:        insertLineBreak → <br>
// The simulation asserts the *decision logic*: multiline goes line-by-line,
// break via insertLineBreak with insertParagraph fallback, single-line and
// empty payloads keep the old code path.

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/content.js', 'utf8');
const start = src.indexOf('function execInsertTextCE');
if (start < 0) { console.error('execInsertTextCE not found'); process.exit(2); }
let i = src.indexOf('{', start), depth = 0, end = null;
for (let idx = i; idx < src.length; idx++) {
  if (src[idx] === '{') depth++;
  else if (src[idx] === '}') { depth--; if (depth === 0) { end = idx + 1; break; } }
}
const fnSource = src.slice(start, end);

// --- DOM/execCommand mock recording command sequences ---
function makeEnv(engine) {
  const calls = [];
  const sel = { ranges: [], removeAllRanges() {}, addRange(r) { this.ranges.push(r); } };
  const commands = {
    // engines: insertText with \n returns true but inserts plain text (the bug)
    insertText: { ok: true },
    insertLineBreak: { ok: engine.hasInsertLineBreak },
    insertParagraph: { ok: true },
    delete: { ok: true },
  };
  return { calls, sel, commands };
}

// eval the extracted function with a fake document/selection scope
function runExtracted(engine, text) {
  const env = makeEnv(engine);
  const fakeDoc = {
    execCommand(cmd, _ui, arg) {
      env.calls.push([cmd, arg]);
      return env.commands[cmd].ok;
    }
  };
  const fakeEl = { focus() {} };
  const fakeWin = { getSelection: () => env.sel };
  const fn = new Function('document', 'window', 'el', 'range', 'text', fnSource.replace(/^function execInsertTextCE\(([^)]*)\) \{/, 'return function($1) {') + '\n');
  // build callable: the extracted body expects document/window closure
  const factory = new Function('document', 'window', fnSource + '\nreturn execInsertTextCE;');
  const execInsertTextCE = factory(fakeDoc, fakeWin);
  const range = { cloneRange() { return this; } };
  return { ok: execInsertTextCE(fakeEl, range, text), calls: env.calls };
}

const engines = [
  { name: 'Blink (Chrome)', hasInsertLineBreak: true },
  { name: 'Gecko (Thunderbird/Firefox)', hasInsertLineBreak: true },
  { name: 'Legacy engine without insertLineBreak', hasInsertLineBreak: false },
];

let fails = 0;
for (const engine of engines) {
  console.log('\n=== ' + engine.name + ' ===');

  // Multiline: line-by-line, breaks as real commands.
  // In the legacy engine the failed insertLineBreak attempt is recorded too
  // (instrumentation), then the insertParagraph fallback runs — correct.
  let r = runExtracted(engine, 'Zeile1\nZeile2\n\nZeile4');
  const expected = [];
  const lines = ['Zeile1', 'Zeile2', '', 'Zeile4'];
  for (let li = 0; li < lines.length; li++) {
    if (lines[li].length > 0) expected.push(['insertText', lines[li]]);
    if (li < lines.length - 1) {
      if (!engine.hasInsertLineBreak) expected.push(['insertLineBreak', null]); // failed attempt
      expected.push([engine.hasInsertLineBreak ? 'insertLineBreak' : 'insertParagraph', null]);
    }
  }
  const ok1 = r.ok === true && JSON.stringify(r.calls) === JSON.stringify(expected);
  if (!ok1) fails++;
  console.log((ok1 ? 'PASS' : 'FAIL') + ' multiline sequence: ' + JSON.stringify(r.calls));

  // single line: unchanged legacy path (plain insertText, no split)
  r = runExtracted(engine, 'nur eine Zeile');
  const ok2 = r.ok === true && JSON.stringify(r.calls) === JSON.stringify([['insertText', 'nur eine Zeile']]);
  if (!ok2) fails++;
  console.log((ok2 ? 'PASS' : 'FAIL') + ' single line: ' + JSON.stringify(r.calls));

  // empty payload: delete
  r = runExtracted(engine, '');
  const ok3 = r.ok === true && JSON.stringify(r.calls) === JSON.stringify([['delete', null]]);
  if (!ok3) fails++;
  console.log((ok3 ? 'PASS' : 'FAIL') + ' empty: ' + JSON.stringify(r.calls));

  // null payload: delete
  r = runExtracted(engine, null);
  const ok4 = r.ok === true && JSON.stringify(r.calls) === JSON.stringify([['delete', null]]);
  if (!ok4) fails++;
  console.log((ok4 ? 'PASS' : 'FAIL') + ' null: ' + JSON.stringify(r.calls));
}

// Also verify the raw-\n bug simulation: plain "\n" insertText produces no
// visible break in a mock DOM — documents why line-by-line is needed.
console.log('\n=== raw insertText newline (the bug, for the record) ===');
const rawBug = { 'Zeile1\nZeile2': 'one text node containing \\n — not rendered as a break by Blink/Gecko editors' };
console.log('documented:', JSON.stringify(rawBug));

console.log(fails === 0 ? '\nALL TESTS PASSED' : '\n' + fails + ' FAILURES');
process.exit(fails ? 1 : 0);