// Loads the packaged extension scripts against a mocked chrome.* API and
// verifies they boot without throwing AND that a fresh install seeds the
// documented defaults — the failure classes the Chrome Web Store's install
// test reports as "does not work as described".
//
// Run: node store-boot-check.js <extracted-extension-dir>
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = process.argv[2] || '/tmp/storecheck/ext';
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');

const problems = [];
function check(name, fn) {
  try { const r = fn(); console.log('  PASS  ' + name); return r; }
  catch (e) { problems.push(name + ': ' + e.message); console.log('  FAIL  ' + name + ' — ' + e.message); }
}

// ---- chrome.* mock -------------------------------------------------------
const storageData = {};
function makeChrome() {
  const named = { installed: [], startup: [], message: [], connect: [], menuClick: [], storageChanged: [] };
  const listeners = [];
  const add = (bucket) => (f) => { listeners.push(f); named[bucket].push(f); };
  return {
    runtime: {
      lastError: undefined,
      id: 'mockextensionidmockextensionidmock',
      getURL: (p) => 'chrome-extension://mock/' + p,
      onInstalled: { addListener: add('installed') },
      onStartup: { addListener: add('startup') },
      onMessage: { addListener: add('message') },
      onConnect: { addListener: add('connect') },
      connect: () => ({ postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }),
      sendMessage: (msg, cb) => { if (typeof cb === 'function') cb({ success: true }); },
    },
    i18n: {
      getUILanguage: () => 'de',
      getMessage: (key) => {
        const msgs = JSON.parse(read('_locales/de/messages.json'));
        const m = msgs[key];
        return m ? m.message : '';
      },
    },
    storage: {
      sync: {
        get: (keys, cb) => {
          const out = {};
          const list = Array.isArray(keys) ? keys : Object.keys(keys || {});
          for (const k of list) {
            out[k] = (k in storageData) ? storageData[k]
              : (keys[k] !== undefined ? keys[k] : undefined);
          }
          if (cb) cb(out);
          return Promise.resolve(out);
        },
        set: (vals, cb) => { Object.assign(storageData, vals); if (cb) cb(); return Promise.resolve(); },
        clear: (cb) => { for (const k of Object.keys(storageData)) delete storageData[k]; if (cb) cb(); },
      },
      onChanged: { addListener: add('storageChanged') },
    },
    contextMenus: {
      removeAll: (cb) => cb && cb(),
      create: (opts, cb) => { if (cb) cb(); },
      onClicked: { addListener: add('menuClick') },
    },
    tabs: {
      sendMessage: (a, b, c, d) => { const cb = [b, c, d].find((x) => typeof x === 'function'); if (cb) cb({ success: true }); },
      query: () => Promise.resolve([]),
    },
    scripting: {
      executeScript: () => Promise.resolve([{ result: null }]),
      compose: { registerScripts: () => Promise.resolve() },
    },
    permissions: { contains: (p, cb) => cb && cb(true) },
    _named: named,
  };
}

function makeContentSandbox(chrome) {
  const el = (tag) => ({
    tagName: String(tag).toUpperCase(), style: {}, dataset: {}, childNodes: [], children: [],
    isConnected: true, nodeType: 1, textContent: '', innerText: '', innerHTML: '',
    id: '', className: '', type: 'text', value: '',
    appendChild(c) { this.childNodes.push(c); this.children.push(c); return c; },
    removeChild(c) { return c; },
    remove() {}, setAttribute() {}, getAttribute: () => null,
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    attachShadow() { return { appendChild() {}, querySelector: () => null, querySelectorAll: () => [] }; },
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 100, bottom: 40, width: 100, height: 40 }),
    contains: () => false, focus() {}, blur() {}, dispatchEvent: () => true,
    insertBefore(c) { return c; }, cloneRange() { return this; },
  });
  const document = {
    title: 'Mock', body: el('body'), documentElement: el('html'), activeElement: null,
    createElement: el,
    createTextNode: (t) => ({ nodeType: 3, textContent: t, length: String(t).length }),
    createRange: () => ({
      selectNodeContents() {}, setStartAfter() {}, setEndBefore() {}, collapse() {},
      insertNode() {}, deleteContents() {}, cloneRange() { return this; },
      setStart() {}, setEnd() {}, collapsed: true, commonAncestorContainer: el('div'),
    }),
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    execCommand: () => true, getElementById: () => null, contains: () => true,
  };
  const window = {
    getSelection: () => ({
      rangeCount: 0, toString: () => '', getRangeAt() { return document.createRange(); },
      removeAllRanges() {}, addRange() {},
    }),
    addEventListener() {}, removeEventListener() {},
    location: { href: 'https://example.com/page' },
    scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0,
    setTimeout: (f) => setTimeout(f, 0), clearTimeout,
    MutationObserver: class { observe() {} disconnect() {} },
    navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/149' },
  };
  window.window = window;
  return { document, window };
}

// Microtask flush: the onInstalled handler seeds defaults through a promise
// chain, so the storage writes are only visible after the queue drains.
const flush = () => new Promise((r) => setTimeout(r, 0));

(async () => {
  console.log('=== Boot-Check der ausgelieferten Extension-Skripte ===\n');
  console.log('Verzeichnis:', dir, '\n');

  // ---- background.js -----------------------------------------------------
  console.log('background.js (Service Worker)');
  const bgChrome = makeChrome();
  const bgSandbox = {
    chrome: bgChrome, browser: bgChrome, console,
    fetch: () => Promise.reject(new Error('net disabled in boot check')),
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, TextDecoder, TextEncoder, AbortController, DOMException, Promise, JSON,
  };
  bgSandbox.self = bgSandbox;
  bgSandbox.globalThis = bgSandbox;

  check('background.js parst', () => { new vm.Script(read('background.js'), { filename: 'background.js' }); });
  check('background.js lädt ohne Exception', () => {
    vm.createContext(bgSandbox);
    vm.runInContext(read('background.js'), bgSandbox, { filename: 'background.js', timeout: 5000 });
  });
  check('onInstalled/onMessage/onConnect registriert', () => {
    const n = bgChrome._named;
    if (!n.installed.length) throw new Error('onInstalled fehlt');
    if (!n.message.length) throw new Error('onMessage fehlt');
    if (!n.connect.length) throw new Error('onConnect fehlt');
  });
  check('onInstalled-Handler wirft nicht', () => {
    for (const l of bgChrome._named.installed) {
      try { l({ reason: 'install' }); } catch (e) {
        if (!/net disabled|fetch/i.test(e.message)) throw e;
      }
    }
  });

  await flush();
  await flush();

  // Every key the background seeds must end up with a defined value — a key in
  // DEFAULT_KEYS without a buildDefaultConfig entry writes `undefined`, so a
  // fresh install renders empty options fields instead of the defaults.
  check('onInstalled seedet alle Keys mit definierten Werten', () => {
    const keys = [...new Set([
      'contextEnabled', 'pageContextChars', 'confirmBeforeReplace',
      'apiUrl', 'model', 'temperature', 'timeoutSeconds',
    ])];
    const undef = keys.filter((k) => storageData[k] === undefined);
    if (undef.length) throw new Error('undefined geseedet: ' + undef.join(', '));
  });
  check('v1.6.0-Defaults korrekt', () => {
    if (storageData.contextEnabled !== false) throw new Error('contextEnabled = ' + JSON.stringify(storageData.contextEnabled));
    if (String(storageData.pageContextChars) !== '600') throw new Error('pageContextChars = ' + JSON.stringify(storageData.pageContextChars));
    if (storageData.confirmBeforeReplace !== false) throw new Error('confirmBeforeReplace = ' + JSON.stringify(storageData.confirmBeforeReplace));
  });

  // ---- content.js --------------------------------------------------------
  console.log('\ncontent.js (Content Script)');
  const ctChrome = makeChrome();
  const { document, window } = makeContentSandbox(ctChrome);
  const ctSandbox = {
    chrome: ctChrome, console, document, window,
    setTimeout, clearTimeout, setInterval, clearInterval,
    URL, TextDecoder, TextEncoder, AbortController, DOMException, Promise, JSON,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    navigator: window.navigator, location: window.location,
  };
  ctSandbox.globalThis = ctSandbox;
  ctSandbox.self = ctSandbox;

  check('content.js parst', () => { new vm.Script(read('content.js'), { filename: 'content.js' }); });
  check('content.js lädt ohne Exception', () => {
    vm.createContext(ctSandbox);
    vm.runInContext(read('content.js'), ctSandbox, { filename: 'content.js', timeout: 5000 });
  });
  check('content.js registriert Message-Listener', () => {
    if (ctChrome._named.message.length < 1) throw new Error('kein Listener');
  });

  // ---- options.js --------------------------------------------------------
  console.log('\noptions.js (Options-Seite)');
  const optChrome = makeChrome();
  const optEls = {};
  const mkEl = (tag) => ({
    tagName: String(tag).toUpperCase(), style: {}, dataset: {}, value: '', textContent: '', innerHTML: '',
    checked: false, className: '', children: [],
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null,
    querySelector: () => null, querySelectorAll: () => [], classList: { add() {}, remove() {} },
    focus() {}, blur() {}, select() {},
  });
  const optDocument = {
    addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') optDocument._ready = fn; },
    getElementById: (id) => (optEls[id] = optEls[id] || mkEl('div')),
    querySelectorAll: () => [], querySelector: () => null,
    createElement: mkEl, createTextNode: (t) => ({ textContent: t }), title: '',
  };
  const optSandbox = {
    chrome: optChrome, console, document: optDocument,
    setTimeout, clearTimeout, Promise, JSON, confirm: () => false,
  };
  optSandbox.globalThis = optSandbox;

  check('options.js parst', () => { new vm.Script(read('options.js'), { filename: 'options.js' }); });
  check('options.js lädt ohne Exception', () => {
    vm.createContext(optSandbox);
    vm.runInContext(read('options.js'), optSandbox, { filename: 'options.js', timeout: 5000 });
  });
  check('options.js DOMContentLoaded-Handler läuft', () => {
    if (!optDocument._ready) throw new Error('kein Handler registriert');
    optDocument._ready();
  });

  console.log('\n=== ERGEBNIS ===');
  if (problems.length) {
    console.log('  ' + problems.length + ' Problem(e):');
    for (const p of problems) console.log('   - ' + p);
    process.exit(1);
  }
  console.log('  Alle Checks bestanden: Skripte booten fehlerfrei, Defaults werden geseedet.');
})();
