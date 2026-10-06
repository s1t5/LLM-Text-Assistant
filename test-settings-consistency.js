// Consistency check across the extension's settings surfaces.
//
// Every storage key the extension reads or writes must be known in ALL of:
//   - DEFAULT_KEYS        (background: what onInstalled seeds / storageGet asks for)
//   - buildDefaultConfig  (background: the value it seeds)
//   - getDefaults         (options: what the page falls back to)
//   - BUILTIN_FIELDS      (options: what save/restore round-trips)
// A key present in one list but missing from another is the class of bug that
// makes a fresh install behave differently from an upgraded one — and that is
// what the Chrome Web Store install test reports as "does not work as
// described".
'use strict';
const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || '/home/hermes/workspace/LLM-Text-Assistant';
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

function objectKeys(src, fnName) {
  const start = src.indexOf('function ' + fnName);
  if (start < 0) return null;
  let i = src.indexOf('{', start), depth = 0, end = null;
  for (let idx = i; idx < src.length; idx++) {
    if (src[idx] === '{') depth++;
    else if (src[idx] === '}') { depth--; if (depth === 0) { end = idx + 1; break; } }
  }
  const body = src.slice(start, end);
  const keys = new Set();
  // Top-level "key:" pairs. Indentation differs between files (background.js
  // uses 4 spaces, options.js getDefaults uses 6) and values may be strings,
  // numbers, booleans, {}, [], t(...) calls or ternaries — so match any
  // indented identifier followed by a colon, and drop nested object members by
  // requiring the key not to be preceded by a deeper indent than the first
  // top-level key seen.
  const lines = body.split('\n');
  let topIndent = null;
  for (const line of lines) {
    const m = line.match(/^(\s+)([a-zA-Z][a-zA-Z0-9_]*)\s*:/);
    if (!m) continue;
    const indent = m[1].length;
    if (topIndent === null) topIndent = indent;
    if (indent === topIndent) keys.add(m[2]);
  }
  return keys;
}

function arrayKeys(src, varName) {
  const m = src.match(new RegExp('const ' + varName + '\\s*=\\s*\\[([\\s\\S]*?)\\]'));
  if (!m) return null;
  return new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
}

const problems = [];
const report = (label, missing, extra, ctx) => {
  if (missing.size || extra.size) {
    const parts = [];
    if (missing.size) parts.push('fehlt in ' + label + ': ' + [...missing].join(', '));
    if (extra.size) parts.push('nur in ' + label + ': ' + [...extra].join(', '));
    problems.push(ctx + ' -> ' + parts.join(' | '));
    console.log('  FAIL  ' + ctx + ' -> ' + parts.join(' | '));
  } else {
    console.log('  PASS  ' + ctx);
  }
};

for (const [label, bgFile, optFile] of [
  ['chrome/firefox', 'background.js', 'options.js'],
  ['thunderbird', 'platform/thunderbird/background.js', 'options.js'],
]) {
  console.log('\n=== ' + label + ' ===');
  const bg = read(bgFile);
  const opt = read(optFile);

  const defaultKeys = arrayKeys(bg, 'DEFAULT_KEYS');
  const defaults = objectKeys(bg, 'buildDefaultConfig');
  const optDefaults = objectKeys(opt, 'getDefaults');
  const builtinFields = arrayKeys(opt, 'BUILTIN_FIELDS');

  for (const [name, s] of [['DEFAULT_KEYS', defaultKeys], ['buildDefaultConfig', defaults],
                           ['getDefaults', optDefaults], ['BUILTIN_FIELDS', builtinFields]]) {
    if (!s) { problems.push(label + ': ' + name + ' nicht gefunden'); console.log('  FAIL  ' + name + ' nicht gefunden'); }
  }
  if (!defaultKeys || !defaults) continue;

  // DEFAULT_KEYS is the contract for what gets seeded: every entry must have a
  // default value, otherwise `undefined` lands in storage.
  report('buildDefaultConfig', new Set([...defaultKeys].filter((k) => !defaults.has(k))), new Set(),
         'DEFAULT_KEYS vs buildDefaultConfig');

  // The options page must know every key the background seeds (it renders the
  // form for them). modelsList is deliberately excluded: it is a fetch cache,
  // not a form field.
  const cacheOnly = new Set(['modelsList']);
  report('getDefaults', new Set([...defaultKeys].filter((k) => !optDefaults.has(k) && !cacheOnly.has(k))),
         new Set([...optDefaults].filter((k) => !defaultKeys.has(k) && !cacheOnly.has(k))),
         'DEFAULT_KEYS vs options getDefaults');

  // BUILTIN_FIELDS drives save/restore; anything the options page has must
  // round-trip (cache-only keys excluded on purpose).
  report('BUILTIN_FIELDS', new Set([...optDefaults].filter((k) => !builtinFields.has(k) && !cacheOnly.has(k))),
         new Set([...builtinFields].filter((k) => !optDefaults.has(k))),
         'options getDefaults vs BUILTIN_FIELDS');
}

console.log('\n=== ERGEBNIS ===');
if (problems.length) {
  console.log('  ' + problems.length + ' Inkonsistenz(en) gefunden.');
  process.exit(1);
}
console.log('  Alle Settings-Oberflächen sind konsistent.');
