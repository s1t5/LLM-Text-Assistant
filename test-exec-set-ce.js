// Verifies the hardened execSetCEText whole-field write (content.js).
// Simulates engine behaviors for select-all + insertText:
//  - good engine: insert over a non-collapsed selection REPLACES it
//  - stacky engine: stale selection state -> insert APPENDS next to the old
//    content (the Thunderbird duplication bug); the fix must detect the
//    mismatch, pipeline-delete and retry once
//  - broken engine: even the retry cannot produce the text -> must return false
// The functions are sliced from the shipped content.js (tests real code).

const fs = require('fs');
const src = fs.readFileSync(__dirname + '/content.js', 'utf8');

function sliceFn(name) {
  const start = src.indexOf('function ' + name);
  if (start < 0) { console.error(name + ' not found'); process.exit(2); }
  let i = src.indexOf('{', start), depth = 0, end = null;
  for (let idx = i; idx < src.length; idx++) {
    if (src[idx] === '{') depth++;
    else if (src[idx] === '}') { depth--; if (depth === 0) { end = idx + 1; break; } }
  }
  return src.slice(start, end);
}

const code = [
  sliceFn('execSetCEText'),
  sliceFn('execDeleteCEContents'),
  sliceFn('execInsertTextCE'),
  sliceFn('getElementFullText'),
  '\nreturn execSetCEText;'
].join('\n');

// --- fake engine -------------------------------------------------------
// kind:
//  'replace' — insert over a non-collapsed selection replaces it
//  'stack'   — insert always appends at the caret (never deletes)
//  'broken'  — like stack, and execCommand('delete') reports ok but is a no-op
function makeEnv(kind) {
  let buffer = 'ALTER TEXT';
  let selectionNonCollapsed = false;
  const el = {
    isContentEditable: true,
    get innerText() { return buffer; },
    set innerText(v) { buffer = v; },
    focus() {}
  };
  const commands = [];
  const doc = {
    createRange() {
      return {
        collapsed: false,
        selectNodeContents() { this.collapsed = false; },
        collapse() { this.collapsed = true; }
      };
    },
    execCommand(cmd, _ui, arg) {
      commands.push([cmd, arg || null]);
      if (cmd === 'insertText') {
        if (kind === 'replace' && selectionNonCollapsed) {
          buffer = arg;              // engine honors the selection: replace
        } else {
          buffer += arg;             // inserted at the caret next to old text
        }
        selectionNonCollapsed = false;
        return true;
      }
      if (cmd === 'insertLineBreak' || cmd === 'insertParagraph') {
        buffer += '\n';
        return true;
      }
      if (cmd === 'delete') {
        if (kind !== 'broken') buffer = '';
        selectionNonCollapsed = false;
        return true;
      }
      return false;
    }
  };
  const sel = {
    removeAllRanges() {},
    addRange(range) { selectionNonCollapsed = !range.collapsed; }
  };
  const win = { getSelection: () => sel };
  const factory = new Function('document', 'window', code);
  const execSetCEText = factory(doc, win);
  return { execSetCEText, el, commands };
}

function countCmds(commands, name) {
  return commands.filter(c => c[0] === name).length;
}

let failed = 0;
function check(label, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + label);
  if (!cond) failed++;
}

// A) good engine: one pass, no corrective delete
{
  const env = makeEnv('replace');
  const ok = env.execSetCEText(env.el, 'Neuer Text\nZweite Zeile');
  check('A replace-engine: returns true', ok === true);
  check('A replace-engine: field equals result', String(env.el.innerText) === 'Neuer Text\nZweite Zeile');
  check('A replace-engine: no corrective delete', countCmds(env.commands, 'delete') === 0);
}

// B) stacky engine: detection + pipeline delete + retry
{
  const env = makeEnv('stack');
  const ok = env.execSetCEText(env.el, 'Neuer Text\nZweite Zeile');
  check('B stack-engine: returns true', ok === true);
  check('B stack-engine: old content gone', String(env.el.innerText).indexOf('ALTER TEXT') === -1);
  check('B stack-engine: field equals result', String(env.el.innerText) === 'Neuer Text\nZweite Zeile');
  check('B stack-engine: corrective delete issued', countCmds(env.commands, 'delete') === 1);
}

// C) broken engine: retry impossible -> false (caller falls back)
{
  const env = makeEnv('broken');
  const ok = env.execSetCEText(env.el, 'Neuer Text');
  check('C broken-engine: returns false', ok === false);
}

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('ALL TESTS PASSED');