// Verifies the v1.5.8 contenteditable completion cleanup in content.js:
//   1. isThunderbirdUA — UA sniff identifying the Thunderbird compose host
//   2. isFrameworkManagedCE — a Thunderbird compose body takes the editing-
//      pipeline path even though it exposes no framework signals (Gecko
//      HTMLEditor owns selection/transaction state like a framework does)
//   3. finalizeCEState — after a completed streaming replacement the empty
//      marker nodes are removed from the field (they would otherwise
//      accumulate — and in Thunderbird ship inside the serialized mail)
//      and the live DOM selection is re-anchored after the replaced text
//      (the caret-jumps-to-field-start bug), covering the content, the
//      empty-result and the single-node streaming modes.
// Pattern: slices the REAL functions out of content.js and runs them
// against a mock DOM (same approach as test-insert-ce.js).

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

// --- mock DOM -----------------------------------------------------------
function makeMockDom() {
  const log = { removed: [], selectionCalls: [], rangeOps: [] };

  function baseNode(nodeType, extra) {
    const node = Object.assign({
      nodeType, parentNode: null, childNodes: [],
      removeChild(c) {
        const i = this.childNodes.indexOf(c);
        if (i < 0) return null;
        this.childNodes.splice(i, 1);
        c.parentNode = null;
        log.removed.push(c);
        return c;
      }
    }, extra);
    Object.defineProperty(node, 'previousSibling', {
      get() {
        const p = this.parentNode;
        if (!p) return null;
        const i = p.childNodes.indexOf(this);
        return i > 0 ? p.childNodes[i - 1] : null;
      }
    });
    return node;
  }

  const text = (data) => baseNode(3, { data, length: data.length });
  const elem = (tag) => baseNode(1, { tagName: tag });

  const append = (p, n) => { n.parentNode = p; p.childNodes.push(n); };

  function contains(root, node) {
    if (node === root) return true;
    for (const c of root.childNodes) if (contains(c, node)) return true;
    return false;
  }

  const selection = {
    ranges: [],
    removeAllRanges() { this.ranges = []; log.selectionCalls.push('removeAllRanges'); },
    addRange(r) { this.ranges.push(r); log.selectionCalls.push('addRange'); }
  };

  function createRange() {
    const r = {
      setStart(n, o) { r._start = [n, o]; log.rangeOps.push(['setStart', n, o]); },
      setStartAfter(n) {
        const p = n.parentNode;
        const i = p ? p.childNodes.indexOf(n) : -1;
        r._start = [p, i + 1];
        log.rangeOps.push(['setStartAfter', n]);
      },
      collapse(toEnd) { log.rangeOps.push(['collapse', toEnd]); }
    };
    return r;
  }

  const el = elem('DIV');
  el.isContentEditable = true;
  el.contains = (n) => contains(el, n);

  const window = { getSelection: () => selection };
  const document = { createRange };

  return { log, text, elem, append, el, selection, window, document };
}

function buildFinalizeCEState(mock, cleanedSelection) {
  return new Function('window', 'document', 'cleanedSelection',
    extractFn('finalizeCEState') + '\nreturn finalizeCEState;')(
    mock.window, mock.document, cleanedSelection);
}

let fails = 0;
const check = (label, ok, detail) => {
  if (!ok) fails++;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + label + (detail ? ' — ' + detail : ''));
};

// --- 1) isThunderbirdUA ---------------------------------------------------
const isThunderbirdUA = new Function(extractFn('isThunderbirdUA') + '\nreturn isThunderbirdUA;')();
check('UA: Thunderbird detected',
  isThunderbirdUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Thunderbird/128.0') === true);
check('UA: Firefox NOT detected',
  isThunderbirdUA('Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/140.0') === false);
check('UA: Chrome NOT detected',
  isThunderbirdUA('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/126.0') === false);
check('UA: empty/undefined safe', isThunderbirdUA('') === false);

// --- 2) isFrameworkManagedCE routes Thunderbird through the pipeline ------
const makeIsFw = (ua) => new Function('navigator',
  extractFn('isThunderbirdUA') + '\n' + extractFn('isFrameworkManagedCE') +
  '\nreturn isFrameworkManagedCE;')({ userAgent: ua });
const bareEditable = { isContentEditable: true };
check('TB compose body -> pipeline (framework path)',
  makeIsFw('Mozilla/5.0 Thunderbird/128.0')(bareEditable) === true);
check('Firefox plain CE -> direct DOM path',
  makeIsFw('Mozilla/5.0 Firefox/140.0')(bareEditable) === false);
check('Chrome plain CE -> direct DOM path',
  makeIsFw('Mozilla/5.0 Chrome/126.0')(bareEditable) === false);

// --- 3) finalizeCEState ----------------------------------------------------
// A: marker mode with content — markers removed, caret after last content node
{
  const mock = makeMockDom();
  const cleanedSelection = new WeakMap();
  const finalizeCEState = buildFinalizeCEState(mock, cleanedSelection);
  const { el, text, elem, append } = mock;
  const before = text('Before ');
  const startM = text('');
  const line1 = text('Zeile eins');
  const br = elem('BR');
  const endM = text('');
  const after = text(' after.');
  [before, startM, line1, br, endM, after].forEach((n) => append(el, n));
  cleanedSelection.set(el, { ceStart: startM, ceEnd: endM, completed: false });

  finalizeCEState(el);

  check('A: both empty markers removed from the field',
    mock.log.removed.length === 2 && mock.log.removed.includes(startM) && mock.log.removed.includes(endM));
  check('A: content nodes untouched',
    el.childNodes.length === 4 && el.childNodes[0] === before && el.childNodes[3] === after);
  check('A: caret anchored after last content node (the <br>)',
    mock.log.rangeOps[0] && mock.log.rangeOps[0][0] === 'setStartAfter' && mock.log.rangeOps[0][1] === br,
    'rangeOps=' + mock.log.rangeOps.map((o) => o[0]).join(','));
  check('A: live selection re-added',
    mock.log.selectionCalls.join(',') === 'removeAllRanges,addRange');
}

// B: marker mode, empty result between markers — caret stays at the old spot
{
  const mock = makeMockDom();
  const cleanedSelection = new WeakMap();
  const finalizeCEState = buildFinalizeCEState(mock, cleanedSelection);
  const { el, text, append } = mock;
  const before = text('Before ');
  const startM = text('');
  const endM = text('');
  const after = text(' after.');
  [before, startM, endM, after].forEach((n) => append(el, n));
  cleanedSelection.set(el, { ceStart: startM, ceEnd: endM, completed: false });

  finalizeCEState(el);

  check('B: markers removed', mock.log.removed.length === 2);
  check('B: caret at former selection spot (parent index)',
    mock.log.rangeOps[0] && mock.log.rangeOps[0][0] === 'setStart' &&
    mock.log.rangeOps[0][1] === el && mock.log.rangeOps[0][2] === 1,
    'rangeOps=' + mock.log.rangeOps.map((o) => [o[0], o[2]]).join(','));
}

// C: single-node streaming mode — no markers, caret at end of the node
{
  const mock = makeMockDom();
  const cleanedSelection = new WeakMap();
  const finalizeCEState = buildFinalizeCEState(mock, cleanedSelection);
  const { el, text, append } = mock;
  const before = text('Before ');
  const node = text('das Ergebnis');
  const after = text(' after.');
  [before, node, after].forEach((n) => append(el, n));
  cleanedSelection.set(el, { node, completed: false });

  finalizeCEState(el);

  check('C: nothing removed (no markers)', mock.log.removed.length === 0);
  check('C: caret at end of result text node',
    mock.log.rangeOps[0] && mock.log.rangeOps[0][0] === 'setStart' &&
    mock.log.rangeOps[0][1] === node && mock.log.rangeOps[0][2] === node.length,
    'rangeOps=' + mock.log.rangeOps.map((o) => o[0]).join(','));
  check('C: live selection re-added',
    mock.log.selectionCalls.join(',') === 'removeAllRanges,addRange');
}

// D: no state at all (pipeline path) — no-op, must not throw
{
  const mock = makeMockDom();
  const cleanedSelection = new WeakMap();
  const finalizeCEState = buildFinalizeCEState(mock, cleanedSelection);
  let threw = false;
  try { finalizeCEState(mock.el); } catch (e) { threw = true; }
  check('D: no state -> no-op without side effects',
    !threw && mock.log.removed.length === 0 && mock.log.rangeOps.length === 0 &&
    mock.log.selectionCalls.length === 0);
}

console.log(fails === 0 ? '\nALL TESTS PASSED' : '\n' + fails + ' FAILURES');
process.exit(fails ? 1 : 0);