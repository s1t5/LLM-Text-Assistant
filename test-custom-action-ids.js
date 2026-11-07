// Verifies that custom actions reach every UI surface WITH an action id.
//
// Bug (Thunderbird, "can't access property \"startsWith\", action is undefined"):
// loadActionsForContent() returned `custom: customActions.filter(...)` — the raw
// stored objects, which carry emoji/title/prompt/showInContextMenu/shortcut but
// NO id. platform/thunderbird/popup.js builds each button from `action.id`, so
// `btn.addEventListener('click', () => triggerAction(action.id))` sent
// `{ textAction: undefined }` to the background, which then called
// buildPromptParts(undefined) → `action.startsWith('custom_')` → TypeError.
//
// The id must be `custom_<ORIGINAL index>` (content.js resolves it against
// config.customActions), so filtering out untitled actions must not renumber
// the survivors.
//
// Pattern: slices loadActionsForContent out of BOTH background files (root +
// Thunderbird overlay) and runs it against a mocked chrome.storage.

const fs = require('fs');
const path = require('path');

let fails = 0;
const check = (label, ok, detail) => {
  if (!ok) fails++;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + (detail ? ' — ' + detail : ''));
};

function extractFn(src, name) {
  const start = src.indexOf('async function ' + name);
  const startSync = src.indexOf('function ' + name);
  const at = start >= 0 ? start : startSync;
  if (at < 0) { console.error('FAIL: ' + name + ' not found'); process.exit(2); }
  let i = src.indexOf('{', at), depth = 0, end = null;
  for (let idx = i; idx < src.length; idx++) {
    if (src[idx] === '{') depth++;
    else if (src[idx] === '}') { depth--; if (depth === 0) { end = idx + 1; break; } }
  }
  return src.slice(at, end);
}

const STORED = [
  { emoji: '⚡', title: 'First', prompt: 'p1', showInContextMenu: true, shortcut: '' },
  { emoji: '⚡', title: '', prompt: 'untitled', showInContextMenu: true, shortcut: '' },
  { emoji: '🔥', title: 'Third', prompt: 'p3', showInContextMenu: true, shortcut: '' }
];

const TARGETS = [
  { name: 'root (Chrome/Firefox)', file: path.join(__dirname, 'background.js') },
  { name: 'thunderbird overlay', file: path.join(__dirname, 'platform/thunderbird/background.js') }
];

for (const target of TARGETS) {
  const src = fs.readFileSync(target.file, 'utf8');
  const fnSrc = extractFn(src, 'loadActionsForContent');

  // Free variables of the sliced function: storageGet, DEFAULT_KEYS,
  // buildDefaultConfig, t, getBuiltinActions.
  const factory = new Function(
    'storageGet', 'DEFAULT_KEYS', 'buildDefaultConfig', 't', 'getBuiltinActions',
    fnSrc + '\nreturn loadActionsForContent;'
  );
  const loadActionsForContent = factory(
    async () => ({ customActions: STORED, freePromptEnabled: true }),
    ['customActions', 'freePromptEnabled'],
    () => ({ freePromptEnabled: true }),
    (k) => k,
    () => [{ id: 'translate', title: 'Translate' }]
  );

  const label = target.name;

  // A1: every returned custom action carries an id
  loadActionsForContent().then((res) => {
    const customs = res.custom || [];
    check(label + ' A1 custom entries carry an id',
      customs.length === 2 && customs.every((a) => typeof a.id === 'string' && a.id.length > 0),
      JSON.stringify(customs.map((a) => a.id)));

    // A2: the id is custom_<original index>, NOT the post-filter position
    check(label + ' A2 ids keep the ORIGINAL list index',
      customs[0] && customs[0].id === 'custom_0' && customs[1] && customs[1].id === 'custom_2',
      JSON.stringify(customs.map((a) => a.id)));

    // A3: the stored fields survive (popup renders emoji/title/shortcut)
    check(label + ' A3 fields survive the mapping',
      customs[1] && customs[1].title === 'Third' && customs[1].emoji === '🔥' && customs[1].prompt === 'p3');

    // A4: an id sent back as textAction passes the background guard
    const sent = customs.map((a) => a.id);
    const guarded = sent.every((id) => typeof id === 'string' && id.startsWith('custom_'));
    check(label + ' A4 ids pass the startsWith("custom_") guard', guarded, JSON.stringify(sent));

    // A5: untitled actions are still hidden (unchanged behaviour)
    check(label + ' A5 untitled actions stay filtered out',
      customs.every((a) => a.title && a.title.trim()));

    // A6: builtin ids are untouched
    check(label + ' A6 builtin ids unchanged',
      Array.isArray(res.builtin) && res.builtin[0] && res.builtin[0].id === 'translate');
  });
}

// A7: the popup reads action.id for BOTH the dataset and the click handler —
// documents the contract this test protects.
const popup = fs.readFileSync(path.join(__dirname, 'platform/thunderbird/popup.js'), 'utf8');
check('A7 popup derives the trigger from action.id',
  /triggerAction\(action\.id\)/.test(popup));

setTimeout(() => {
  console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILURE(S)');
  process.exit(fails === 0 ? 0 : 1);
}, 50);
