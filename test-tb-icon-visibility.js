// Regression tests for the Thunderbird floating-icon visibility fix
// (content.js).
//
// In Thunderbird the compose editor is a SUBFRAME of the compose window. It
// blurs whenever the compose chrome (subject line, toolbar, …) takes focus,
// while the mail body stays the active editing field. The old handler hid the
// icon on every window blur and nothing re-showed it when the frame regained
// focus (no focusin fires for a field that never lost DOM focus), so the icon
// was only visible while an action forced it. The handlers are sliced from the
// shipped content.js (tests real code).

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
  sliceFn('handleWindowBlur'),
  sliceFn('handleWindowFocus'),
  '\nreturn { handleWindowBlur, handleWindowFocus };'
].join('\n');

function makeEnv({ thunderbird, suspended, active, inDocument }) {
  const calls = { hide: 0, show: 0 };
  const factory = new Function(
    'isThunderbirdUA', 'hideFloatingIcon', 'showFloatingIcon',
    'uiSuspended', 'activeInputElement', 'isNodeInDocument', code);
  const api = factory(
    () => thunderbird,
    () => { calls.hide++; },
    () => { calls.show++; },
    suspended,
    active,
    () => inDocument);
  return { api, calls };
}

let failed = 0;
function check(label, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + label);
  if (!cond) failed++;
}

// A) Frame blur hides the per-frame icon; the focus handler brings it back
{
  const env = makeEnv({ thunderbird: true, suspended: false, active: {}, inDocument: true });
  env.api.handleWindowBlur();
  check('A blur hides the icon', env.calls.hide === 1);
}

// B) Same in a browser/iframe
{
  const env = makeEnv({ thunderbird: false, suspended: false, active: {}, inDocument: true });
  env.api.handleWindowBlur();
  check('B non-TB blur hides the icon', env.calls.hide === 1);
}

// C) Frame regained focus, field still active: re-show the icon
{
  const env = makeEnv({ thunderbird: true, suspended: false, active: {}, inDocument: true });
  env.api.handleWindowFocus();
  check('C focus re-shows the icon', env.calls.show === 1);
}

// D) Suspended before send: no icon
{
  const env = makeEnv({ thunderbird: true, suspended: true, active: {}, inDocument: true });
  env.api.handleWindowFocus();
  check('D suspended: no icon', env.calls.show === 0);
}

// E) No remembered field: nothing to attach to
{
  const env = makeEnv({ thunderbird: true, suspended: false, active: null, inDocument: true });
  env.api.handleWindowFocus();
  check('E no active field: no icon', env.calls.show === 0);
}

// F) Field left the document: no icon
{
  const env = makeEnv({ thunderbird: true, suspended: false, active: {}, inDocument: false });
  env.api.handleWindowFocus();
  check('F detached field: no icon', env.calls.show === 0);
}

// G) Wiring: init registers both handlers and shows the icon for an
// already-focused field in Thunderbird (compose body focus predates injection)
{
  const wired = src.indexOf("window.addEventListener('blur', handleWindowBlur)") !== -1 &&
    src.indexOf("window.addEventListener('focus', handleWindowFocus)") !== -1;
  check('G blur/focus handlers registered', wired);
  const init = sliceFn('init');
  const tbShow = init.indexOf('if (isThunderbirdUA())') !== -1 &&
    init.indexOf('showFloatingIcon()') !== -1;
  check('G TB shows the icon for an already focused field', tbShow);
}

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('ALL TESTS PASSED');
