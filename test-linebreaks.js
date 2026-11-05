// Regressionstest: Zeilenumbruch- vs. Absatz-Erhalt beim Ersetzen im
// Thunderbird-Compose-Editor.
//
// Problem (v1.6.6): execInsertTextCE schrieb JEDEN "\n" als <br>. In
// Thunderbird ist <br> ein WEICHER Umbruch (Zeilenumbruch im selben Absatz);
// Absatzgrenzen werden als Block (<div>/<p>) erzeugt. Ein Absatz im
// LLM-Ergebnis ("\n\n") wurde so zu zwei <br> im selben Absatz — beim
// Serialisieren/Anzeigen erscheint das als Absatzumbruch, und ein einfacher
// Umbruch wurde ebenfalls zum Absatz. Zudem liefert innerText Absatzgrenzen
// ebenfalls als "\n", sodass die Absicht beim Zurückschreiben verloren geht.
//
// Vertrag:
//   "\n"   -> insertLineBreak  (<br>, weicher Umbruch, gleicher Absatz)
//   "\n\n" -> insertParagraph  (neuer Absatz)
//   "\n\n\n" -> zwei insertParagraph (Leerzeile zwischen Absätzen)

const fs = require('fs');
const path = require('path');

const root = process.argv[2] || __dirname;
const src = fs.readFileSync(path.join(root, 'content.js'), 'utf8');

function sliceFn(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function not found: ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for (let idx = i; idx < src.length; idx++) {
    if (src[idx] === '{') depth++;
    else if (src[idx] === '}') { depth--; if (depth === 0) return src.slice(start, idx + 1); }
  }
  throw new Error('unbalanced function: ' + name);
}

const factory = new Function(
  'document', 'window',
  sliceFn('execInsertTextCE') + '\nreturn execInsertTextCE;'
);

function run(text, engine) {
  const calls = [];
  const sel = { ranges: [], removeAllRanges() { this.ranges = []; }, addRange(r) { this.ranges.push(r); } };
  const doc = {
    execCommand(cmd, ui, arg) {
      calls.push(arg === undefined || arg === null ? [cmd] : [cmd, arg]);
      if (cmd === 'insertLineBreak') return engine.lineBreak;
      if (cmd === 'insertParagraph') return engine.paragraph;
      return true;
    },
  };
  const win = { getSelection: () => sel };
  const fn = factory(doc, win);
  const ok = fn({ focus() {} }, { cloneRange() { return this; } }, text);
  return { ok, calls };
}

let fails = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log((ok ? 'PASS ' : 'FAIL ') + label);
  if (!ok) {
    console.log('      expected: ' + JSON.stringify(expected));
    console.log('      actual  : ' + JSON.stringify(actual));
  }
}

const full = { lineBreak: true, paragraph: true };

console.log('=== L1: einfacher Umbruch -> insertLineBreak, KEIN insertParagraph ===');
check('"A\\nB"', run('A\nB', full).calls, [['insertText', 'A'], ['insertLineBreak'], ['insertText', 'B']]);

console.log('\n=== L2: Absatz ("\\n\\n") -> insertParagraph ===');
check('"A\\n\\nB"', run('A\n\nB', full).calls,
  [['insertText', 'A'], ['insertParagraph'], ['insertText', 'B']]);

console.log('\n=== L3: gemischt: Zeile, Absatz, Zeile ===');
check('"A\\nB\\n\\nC\\nD"', run('A\nB\n\nC\nD', full).calls,
  [['insertText', 'A'], ['insertLineBreak'], ['insertText', 'B'],
   ['insertParagraph'], ['insertText', 'C'], ['insertLineBreak'], ['insertText', 'D']]);

console.log('\n=== L4: Leerzeile zwischen Absaetzen ("\\n\\n\\n") -> zwei insertParagraph ===');
check('"A\\n\\n\\nB"', run('A\n\n\nB', full).calls,
  [['insertText', 'A'], ['insertParagraph'], ['insertParagraph'], ['insertText', 'B']]);

console.log('\n=== L5: vier Umbrueche = 2 Leerzeilen ===');
check('"A\\n\\n\\n\\nB"', run('A\n\n\n\nB', full).calls,
  [['insertText', 'A'], ['insertParagraph'], ['insertParagraph'], ['insertParagraph'], ['insertText', 'B']]);

console.log('\n=== L6: fuehrender Umbruch bleibt Umbruch ===');
check('"\\nA"', run('\nA', full).calls, [['insertLineBreak'], ['insertText', 'A']]);

console.log('\n=== L7: CRLF normalisiert (LLM/HTTP) ===');
check('"A\\r\\nB"', run('A\r\nB', full).calls, [['insertText', 'A'], ['insertLineBreak'], ['insertText', 'B']]);
check('"A\\r\\n\\r\\nB"', run('A\r\n\r\nB', full).calls,
  [['insertText', 'A'], ['insertParagraph'], ['insertText', 'B']]);

console.log('\n=== L8: Engine ohne insertParagraph -> Fallback auf zwei insertLineBreak ===');
check('"A\\n\\nB"', run('A\n\nB', { lineBreak: true, paragraph: false }).calls,
  [['insertText', 'A'], ['insertParagraph'], ['insertLineBreak'], ['insertLineBreak'], ['insertText', 'B']]);

console.log('\n=== L9: Absatz am Ende/Anfang des Payloads ===');
check('"A\\n\\n"', run('A\n\n', full).calls,
  [['insertText', 'A'], ['insertParagraph']]);
check('"\\n\\nB"', run('\n\nB', full).calls,
  [['insertParagraph'], ['insertText', 'B']]);

console.log('\n=== L10: Single-Line und leer bleiben unveraendert ===');
check('"eine Zeile"', run('eine Zeile', full).calls, [['insertText', 'eine Zeile']]);
check('""', run('', full).calls, [['delete']]);

console.log('\n=== L11: Lese-Seite ist blockbewusst ===');
const hasHelper = src.indexOf('function rangeToSourceText') >= 0;
if (!hasHelper) { fails++; console.log('FAIL rangeToSourceText helper missing'); }
else { console.log('PASS rangeToSourceText helper present'); }
const selUses = /text:\s*rangeToSourceText\(range, el\)/.test(src);
if (!selUses) { fails++; console.log('FAIL getElementSelection does not use rangeToSourceText'); }
else { console.log('PASS getElementSelection reads block-aware source text'); }
const fullUses = /function getElementFullText[\s\S]{0,900}?rangeToSourceText\(range, element\)/.test(src);
if (!fullUses) { fails++; console.log('FAIL getElementFullText does not use rangeToSourceText'); }
else { console.log('PASS getElementFullText reads block-aware'); }

console.log(fails === 0 ? '\nALL TESTS PASSED' : '\n' + fails + ' FAILURES');
process.exit(fails ? 1 : 0);
