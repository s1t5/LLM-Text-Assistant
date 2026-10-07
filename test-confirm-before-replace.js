// Regression guard for the "Ergebnis vor dem Ersetzen bestätigen" setting
// (confirmBeforeReplace).
//
// Contract: while the setting is ON, NOTHING may reach the target field before
// the user clicks "Übernehmen". The original bug was that both streaming paths
// kept writing per token, so the field already showed the new text when the
// diff overlay appeared — and "Abbrechen" had to write the old text back.
//
// The gate is `const deferWrite = confirmBeforeReplace;` captured ONCE at the
// start of each replacement run (a mid-stream toggle must not produce a
// half-written field). These assertions pin the gate into every write path so
// a future refactor cannot silently re-add a pre-write.
'use strict';
const fs = require('fs');
const path = require('path');

// Default to the directory this script lives in — never an absolute path, so
// the check also works in CI, where the checkout lives somewhere else.
const dir = process.argv[2] || __dirname;
const content = fs.readFileSync(path.join(dir, 'content.js'), 'utf8');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'ok   ' : 'FAIL ') + label + (ok || !detail ? '' : ' — ' + detail));
}

// Slice a function body out of the shipped source by brace depth, so the test
// inspects real code instead of a copy.
function fnBody(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

// --- full-field streaming path -------------------------------------------
const full = fnBody(content, 'startFullTextReplacement');
check('startFullTextReplacement exists', !!full);
if (full) {
  check('full-text: write policy fixed at start (deferWrite)',
    /const deferWrite = confirmBeforeReplace;/.test(full));
  check('full-text: streaming buffered while confirming',
    /const bufferStream = deferWrite \|\| \(el\.isContentEditable && isFrameworkManagedCE\(el\)\);/.test(full));
  check('full-text: finish() gates on the captured flag, not the live setting',
    /if \(deferWrite\) \{/.test(full) && !/if \(confirmBeforeReplace\) \{/.test(full));
  check('full-text: error path does not rewrite an untouched field',
    /if \(!deferWrite\) replaceFullTextInElement\(el, text\);/.test(full));
  check('full-text: abort path leaves an untouched field alone',
    /if \(deferWrite\) \{[\s\S]{0,120}Nothing reached the field/.test(full));
}

// --- selection streaming path --------------------------------------------
const sel = fnBody(content, 'startSelectionReplacement');
check('startSelectionReplacement exists', !!sel);
if (sel) {
  check('selection: write policy fixed at start (deferWrite)',
    /const deferWrite = confirmBeforeReplace;/.test(sel));
  check('selection: non-final chunks are dropped while confirming',
    /const applyChunk = \(newText, isFinal\) => \{\s*if \(deferWrite && !isFinal\) return;/.test(sel));
  check('selection: finish() gates on the captured flag, not the live setting',
    /if \(deferWrite\) \{/.test(sel) && !/if \(confirmBeforeReplace\) \{/.test(sel));
  check('selection: discard does NOT write the original back (nothing was written)',
    !/onDiscard|\(\) => \{[\s\S]{0,400}replaceFullTextInElement\(el, originalFullText/.test(sel) &&
    !/replaceFullTextInElement\(el, originalFullText/.test(sel));
}

// --- legacy message paths (background fallback, no streaming port) --------
const legacyFull = fnBody(content, 'replaceFullText');
check('replaceFullText exists', !!legacyFull);
if (legacyFull) {
  check('legacy full-text: honors the confirm gate',
    /if \(confirmBeforeReplace\) \{\s*showDiffConfirm\(/.test(legacyFull));
  check('legacy full-text: write moved into the apply callback',
    /const doApply = \(\) => \{[\s\S]*replaceFullTextInElement\(el, newText\)/.test(legacyFull));
}

const legacySel = fnBody(content, 'replaceSelectedText');
check('replaceSelectedText exists', !!legacySel);
if (legacySel) {
  check('legacy selection: honors the confirm gate',
    /if \(confirmBeforeReplace\) \{[\s\S]*showDiffConfirm\(/.test(legacySel));
  check('legacy selection: delegates the actual write',
    /replaceSelectedTextImmediate\(newText\)/.test(legacySel));
}
check('replaceSelectedTextImmediate (the ungated writer) exists',
  !!fnBody(content, 'replaceSelectedTextImmediate'));

// --- chat "apply last result" path ---------------------------------------
const applyLast = fnBody(content, 'applyLastResult');
check('applyLastResult exists', !!applyLast);
if (applyLast) {
  check('chat apply: still gated by the confirm setting',
    /if \(confirmBeforeReplace\) \{\s*showDiffConfirm\(/.test(applyLast));
}

// --- the option must be mirrored, never read live in a hot path ----------
check('confirmBeforeReplace is mirrored into a content-script variable',
  /chrome\.storage\.sync\.get\(\{ confirmBeforeReplace: false \}/.test(content) &&
  /let confirmBeforeReplace = false;/.test(content));

console.log(failures ? '\n' + failures + ' check(s) failed' : '\nall checks passed');
process.exit(failures ? 1 : 0);
