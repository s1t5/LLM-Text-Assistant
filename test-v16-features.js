// Verifies the v1.6.0 additions that are pure logic and therefore testable
// without a browser:
//   - diffWords (content.js): word-level diff used by the confirm-before-
//     replace preview — must mark removals/insertions, keep equal runs and
//     fall back to a whole-block diff for oversized inputs
//   - modelsUrlFromApiUrl (background.js): deriving GET <base>/models from the
//     configured chat-completions URL for OpenAI/Ollama/LM Studio/llama.cpp
//   - collectPageContext (content.js): page context collection for the free
//     prompt, incl. the character cap and the 0 = off contract
// Functions are sliced from the shipped sources (tests real code, not copies).

const fs = require('fs');
const contentSrc = fs.readFileSync(__dirname + '/content.js', 'utf8');
const bgSrc = fs.readFileSync(__dirname + '/background.js', 'utf8');

function sliceFn(src, name) {
  const start = src.indexOf('function ' + name);
  if (start < 0) { console.error(name + ' not found'); process.exit(2); }
  let i = src.indexOf('{', start), depth = 0, end = null;
  for (let idx = i; idx < src.length; idx++) {
    if (src[idx] === '{') depth++;
    else if (src[idx] === '}') { depth--; if (depth === 0) { end = idx + 1; break; } }
  }
  return src.slice(start, end);
}

let pass = 0, fail = 0;
function ok(cond, label) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
}

// ---------------------------------------------------------------- diffWords
console.log('diffWords (content.js)');

const diffFactory = new Function(
  sliceFn(contentSrc, 'diffWords') + '\nreturn diffWords;'
);
const diffWords = diffFactory();

{
  const segs = diffWords('hello world', 'hello brave world');
  ok(segs.some(s => s.type === 'ins' && /brave/.test(s.text)), 'insertion is marked');
  ok(segs.some(s => s.type === 'eq' && /hello/.test(s.text)), 'common prefix stays equal');
  ok(!segs.some(s => s.type === 'del'), 'no spurious deletion');
  ok(segs.map(s => s.text).join('').replace(/\s+/g, ' ').trim() === 'hello brave world',
     'segments reconstruct the new text');
}

{
  const segs = diffWords('The quick brown fox', 'The slow brown fox');
  ok(segs.some(s => s.type === 'del' && /quick/.test(s.text)), 'removal is marked');
  ok(segs.some(s => s.type === 'ins' && /slow/.test(s.text)), 'replacement is marked');
  ok(segs.some(s => s.type === 'eq' && /brown fox/.test(s.text)), 'shared tail stays equal');
}

{
  const segs = diffWords('same text', 'same text');
  ok(segs.every(s => s.type === 'eq'), 'identical input -> only equal segments');
}

{
  // Oversized input must not build the O(n*m) table; it degrades to del+ins.
  const big = 'w '.repeat(2000);
  const segs = diffWords(big, big + 'extra');
  ok(segs.length === 2 && segs[0].type === 'del' && segs[1].type === 'ins',
     'oversized input falls back to a whole-block diff');
}

{
  const segs = diffWords('', 'brand new');
  ok(segs.every(s => s.type === 'ins'), 'empty old text -> all insertions');
}

// ------------------------------------------------------ modelsUrlFromApiUrl
console.log('modelsUrlFromApiUrl (background.js)');

const modelsFactory = new Function(
  sliceFn(bgSrc, 'modelsUrlFromApiUrl') + '\nreturn modelsUrlFromApiUrl;'
);
const modelsUrl = modelsFactory();

ok(modelsUrl('https://api.openai.com/v1/chat/completions') === 'https://api.openai.com/v1/models',
   'OpenAI chat URL -> /v1/models');
ok(modelsUrl('http://localhost:11434/v1/chat/completions') === 'http://localhost:11434/v1/models',
   'Ollama chat URL -> /v1/models');
ok(modelsUrl('http://localhost:1234/v1/chat/completions/') === 'http://localhost:1234/v1/models',
   'trailing slash is tolerated');
ok(modelsUrl('http://localhost:8080/v1') === 'http://localhost:8080/v1/models',
   'bare base URL -> base + /models');
ok(modelsUrl('https://example.com/api/completions') === 'https://example.com/api/models',
   'legacy /completions -> /models');
ok(modelsUrl('') === '', 'empty input -> empty result (caller reports the error)');

// ------------------------------------------------------ collectPageContext
console.log('collectPageContext (content.js)');

// Minimal DOM stand-ins: collectPageContext only touches document.title,
// location.href and previous/nextElementSibling on the field's parent.
function makeEnv(children, title, href) {
  const nodes = children.map((txt) => ({ innerText: txt, textContent: txt }));
  nodes.forEach((n, i) => {
    n.previousElementSibling = i > 0 ? nodes[i - 1] : null;
    n.nextElementSibling = i < nodes.length - 1 ? nodes[i + 1] : null;
  });
  const field = { parentElement: { childNodes: nodes } };
  // The field itself is one of the siblings; locate it by identity marker.
  const fieldNode = { innerText: '', textContent: '', isField: true };
  return { nodes, field, fieldNode, title, href };
}

const ctxFactory = new Function(
  'document', 'location',
  sliceFn(contentSrc, 'normalizeCtxText') + '\n' +
  sliceFn(contentSrc, 'collectPageContext') + '\n' +
  'return { collectPageContext, normalizeCtxText };'
);

// Build a parent whose children are [p1, p2, FIELD, p4, p5].
// The FIELD's own content must never appear in the context (it is already the
// chat context), so the harness gives it a distinctive text to detect leaks.
function buildEnv(title, href) {
  const mk = (t) => ({ innerText: t, textContent: t });
  const p1 = mk('Absatz eins.');
  const p2 = mk('Absatz zwei.');
  const field = mk('FELDINHALT_DARF_NICHT_DRIN_SEIN');
  field.isField = true;
  const p4 = mk('Absatz vier.');
  const p5 = mk('Absatz fuenf.');
  const kids = [p1, p2, field, p4, p5];
  kids.forEach((n, i) => {
    n.previousElementSibling = i > 0 ? kids[i - 1] : null;
    n.nextElementSibling = i < kids.length - 1 ? kids[i + 1] : null;
  });
  // The field's siblings ARE the children of its parent (the field sits among
  // them); previous/nextElementSibling on the field point at p2 / p4.
  field.parentElement = { childNodes: kids };
  const doc = { title };
  const loc = { href };
  const api = ctxFactory(doc, loc);
  return { api, field };
}

{
  const { api, field } = buildEnv('Meine Seite', 'https://example.com/x');
  const out = api.collectPageContext(field, 600);
  ok(/TITLE: Meine Seite/.test(out), 'title is included');
  ok(/URL: https:\/\/example\.com\/x/.test(out), 'URL is included');
  ok(/Absatz zwei/.test(out) && /Absatz vier/.test(out), 'neighbouring paragraphs are included');
  ok(out.indexOf('Absatz zwei') < out.indexOf('Absatz vier'), 'before/after keep document order');
  ok(out.indexOf('Absatz eins') < out.indexOf('Absatz zwei'), 'before-paragraphs read in document order');
  ok(!/FELDINHALT_DARF_NICHT_DRIN_SEIN/.test(out), "the field's own text is not duplicated into the context");
}

{
  const { api, field } = buildEnv('T', 'https://example.com');
  ok(api.collectPageContext(field, 0) === '', 'maxChars 0 -> no context (off contract)');
  ok(api.collectPageContext(field, '0') === '', 'maxChars "0" (string from storage) -> off');
  ok(api.collectPageContext(field, '') === '', 'empty maxChars -> off');
}

{
  const { api, field } = buildEnv('T', 'https://example.com');
  const out = api.collectPageContext(field, 40);
  ok(out.length <= 40, 'result respects the character cap (' + out.length + ' <= 40)');
}

{
  const { api } = buildEnv('T', 'https://example.com');
  ok(api.collectPageContext(null, 600).indexOf('TITLE: T') === 0,
     'null field still yields title/URL without throwing');
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILURES') + ' — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
