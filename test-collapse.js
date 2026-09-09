// Test for collapseSelectionLineBreaks — extracted verbatim from content.js.
// Run: node test-collapse.js  (exits non-zero on any failure)
const src = require('fs').readFileSync(__dirname + '/content.js', 'utf8');
const start = src.indexOf('function collapseSelectionLineBreaks');
if (start < 0) { console.error('function not found'); process.exit(2); }
let i = src.indexOf('{', start), depth = 0, end = null;
for (let idx = i; idx < src.length; idx++) {
  if (src[idx] === '{') depth++;
  else if (src[idx] === '}') { depth--; if (depth === 0) { end = idx + 1; break; } }
}
eval(src.slice(start, end));

const cases = [
  // [input, expected]
  ["eins\nzwei", "eins zwei"],
  ["eins\r\n\r\nzwei", "eins zwei"],
  ["\nAnfang", "Anfang"],
  ["Ende\n", "Ende"],
  ["\t\n \n Endlich \n \t", "Endlich"],
  ["kein Umbruch", "kein Umbruch"],
  ["a\n b", "a b"],
  ["Wort1 \n\t Wort2", "Wort1 Wort2"],
  ["\n", ""],
  ["", ""],
  ["Zeile1\nZeile2\nZeile3", "Zeile1 Zeile2 Zeile3"],
  ["Punkt.\n\nNächster Satz", "Punkt. Nächster Satz"],
  ["\t\n \n Endlich \n \t", "Endlich"],
  ["  \n  \n  A", "A"],
  ["Z  \n", "Z"],
  ["  führendes Leerzeichen bleibt", "  führendes Leerzeichen bleibt"],
];

let fails = 0;
for (const [input, want] of cases) {
  const got = collapseSelectionLineBreaks(input);
  const ok = got === want;
  if (!ok) fails++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + JSON.stringify(input) + ' -> ' + JSON.stringify(got) + (ok ? '' : '   want: ' + JSON.stringify(want)));
}
console.log(fails === 0 ? 'ALL ' + cases.length + ' TESTS PASSED' : fails + ' FAILURES');
process.exit(fails ? 1 : 0);