// Regression tests for the Thunderbird "whole-field replacement kills the UI"
// bug (content.js).
//
// In Thunderbird the compose body IS document.body and the add-in's UI host
// (the closed shadow root with icon, menu, chat and toasts) is one of its
// children. A whole-field write used to select ALL children of the body, so
// the first insertText deleted the host: after the replacement the icon was
// gone and the add-in could not be opened again. Two layers fix that:
//   1. detachUiHostWithin/execSetCEText keep the host out of the write and put
//      it back afterwards (even when the engine throws or rejects the write).
//   2. dropStaleUiRefs lets every show path rebuild the UI when a cached
//      element points into a detached shadow root (undo restore, draft, …).
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

let failed = 0;
function check(label, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + label);
  if (!cond) failed++;
}

// --- minimal DOM nodes -------------------------------------------------
function makeNode(label) {
  const node = {
    label,
    parentNode: null,
    childNodes: [],
    isConnected: false,
    get nextSibling() {
      if (!this.parentNode) return null;
      const list = this.parentNode.childNodes;
      const i = list.indexOf(this);
      return i >= 0 && i + 1 < list.length ? list[i + 1] : null;
    },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      child.isConnected = this.isConnected;
      return child;
    },
    insertBefore(child, ref) {
      if (child.parentNode) child.parentNode.removeChild(child);
      const i = ref ? this.childNodes.indexOf(ref) : -1;
      child.parentNode = this;
      if (i < 0) this.childNodes.push(child);
      else this.childNodes.splice(i, 0, child);
      child.isConnected = this.isConnected;
      return child;
    },
    removeChild(child) {
      const i = this.childNodes.indexOf(child);
      if (i >= 0) this.childNodes.splice(i, 1);
      child.parentNode = null;
      child.isConnected = false;
      return child;
    },
    contains(other) {
      let n = other;
      while (n) { if (n === this) return true; n = n.parentNode; }
      return false;
    }
  };
  return node;
}

// --- whole-field write environment ------------------------------------
// kind 'replace' = insertText over the select-all replaces the content;
// kind 'reject'  = the engine refuses every insertText (returns false).
function makeWriteEnv(kind, hostInside) {
  let buffer = 'ALTER TEXT';
  let selectionNonCollapsed = false;
  let hostInFirstSelect = false;
  let selects = 0;

  const body = makeNode('body');
  body.isConnected = true;
  const text = makeNode('text');
  text.isConnected = true;
  text.parentNode = body;
  body.childNodes.push(text);

  const host = makeNode('ui-host');
  if (hostInside) body.appendChild(host);

  body.tagName = 'BODY';
  body.isContentEditable = true;
  body.focus = () => {};
  Object.defineProperty(body, 'innerText', {
    get() { return buffer; },
    set(v) {
      buffer = v;
      // innerText replaces every child (the direct-write path).
      for (const c of body.childNodes.slice()) body.removeChild(c);
    }
  });

  const commands = [];
  const doc = {
    createRange() {
      return {
        collapsed: false,
        selectNodeContents(el) {
          this.collapsed = false;
          // The first select-all is the write range; later calls come from
          // the read-back verification and must not overwrite the evidence.
          if (selects++ === 0) hostInFirstSelect = el.childNodes.indexOf(host) !== -1;
        },
        collapse() { this.collapsed = true; }
      };
    },
    execCommand(cmd, _ui, arg) {
      commands.push([cmd, arg || null]);
      if (cmd === 'insertText') {
        if (kind === 'reject') return false;
        if (!selectionNonCollapsed) return false;
        for (const c of body.childNodes.slice()) body.removeChild(c);
        buffer = arg;
        selectionNonCollapsed = false;
        return true;
      }
      if (cmd === 'delete') {
        for (const c of body.childNodes.slice()) body.removeChild(c);
        buffer = '';
        selectionNonCollapsed = false;
        return true;
      }
      if (cmd === 'insertLineBreak' || cmd === 'insertParagraph') {
        buffer += '\n';
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

  const code = [
    sliceFn('detachUiHostWithin'),
    sliceFn('execSetCEText'),
    sliceFn('execDeleteCEContents'),
    sliceFn('execInsertTextCE'),
    sliceFn('getElementFullText'),
    '\nreturn { execSetCEText, detachUiHostWithin };'
  ].join('\n');
  const factory = new Function('document', 'window', 'uiHost', code);
  const api = factory(doc, win, host);
  return {
    api, body, host, commands,
    get hostInFirstSelect() { return hostInFirstSelect; }
  };
}

// A) host inside the editable body: kept out of the select-all, restored after
{
  const env = makeWriteEnv('replace', true);
  const ok = env.api.execSetCEText(env.body, 'Neuer Text');
  check('A returns true', ok === true);
  check('A field holds the result', env.body.innerText === 'Neuer Text');
  check('A host was NOT part of the select-all range', env.hostInFirstSelect === false);
  check('A host is back inside the body', env.host.parentNode === env.body);
  check('A host is connected again', env.host.isConnected === true);
}

// B) engine rejects the write: restore still runs (finally), field untouched
{
  const env = makeWriteEnv('reject', true);
  const ok = env.api.execSetCEText(env.body, 'Neuer Text');
  check('B returns false', ok === false);
  check('B host is back inside the body', env.host.parentNode === env.body);
  check('B host is connected again', env.host.isConnected === true);
}

// C) host NOT inside the field (browser editor): untouched
{
  const env = makeWriteEnv('replace', false);
  const ok = env.api.execSetCEText(env.body, 'Neuer Text');
  check('C returns true', ok === true);
  check('C host untouched', env.host.parentNode === null);
}

// D) host === field: never detach the field itself
{
  const env = makeWriteEnv('replace', false);
  const restore = env.api.detachUiHostWithin(env.host);
  check('D returns null for host === el', restore === null);
}

// --- cached UI refs ---------------------------------------------------
// dropStaleUiRefs must clear references whose nodes left the document and
// leave live ones alone. showFloatingIcon must then build a new icon instead
// of styling the orphan one.
function makeUiEnv(state) {
  const code = [
    sliceFn('dropStaleUiRefs'),
    sliceFn('showFloatingIcon'),
    // Stub for the real icon builder: records the call and installs a live
    // icon so showFloatingIcon can continue styling it.
    'function createFloatingIcon() { created++; floatingIcon = { style: {}, isConnected: true }; }',
    '\nreturn {',
    '  dropStaleUiRefs, showFloatingIcon,',
    '  get: () => ({ uiHost, uiRoot, floatingIcon, actionMenu, chatWindow,',
    '    chatStreamingBubble, chatStreamingText, chatSendBtn, chatInputField,',
    '    diffOverlay, pendingConfirm, undoToast, undoToastTimer, created })',
    '};'
  ].join('\n');
  const factory = new Function(
    'uiHost', 'uiRoot', 'floatingIcon', 'actionMenu', 'chatWindow',
    'chatStreamingBubble', 'chatStreamingText', 'chatSendBtn', 'chatInputField',
    'diffOverlay', 'pendingConfirm', 'undoToast', 'undoToastTimer',
    'clearTimeout', 'uiSuspended', 'activeInputElement', 'savedIconPosition',
    'window', 'updateIconPosition', 'created', code);
  const api = factory(
    state.uiHost || null, state.uiRoot || null, state.floatingIcon || null,
    state.actionMenu || null, state.chatWindow || null, null, '', null, null,
    state.diffOverlay || null, null, state.undoToast || null, state.undoToastTimer || 1,
    () => { timersCleared++; }, false,
    { getBoundingClientRect: () => ({ width: 120, height: 40 }) },
    null, { scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0, addEventListener: () => {} }, () => {}, 0);
  return api;
}

let timersCleared = 0;

// E) stale refs (detached nodes) are dropped, live ones kept
{
  const liveHost = { isConnected: true };
  const liveIcon = { isConnected: true };
  const api = makeUiEnv({
    uiHost: liveHost,
    floatingIcon: liveIcon,
    actionMenu: { isConnected: false },
    chatWindow: { isConnected: false },
    diffOverlay: { isConnected: false },
    undoToast: { isConnected: false }
  });
  const dropped = api.dropStaleUiRefs();
  const s = api.get();
  check('E reports dropped refs', dropped === true);
  check('E live host kept', s.uiHost === liveHost);
  check('E live icon kept', s.floatingIcon === liveIcon);
  check('E stale menu dropped', s.actionMenu === null);
  check('E stale chat dropped', s.chatWindow === null);
  check('E stale diff dropped', s.diffOverlay === null && s.pendingConfirm === null);
  check('E stale toast dropped', s.undoToast === null);
  check('E stale toast timer cleared', timersCleared === 1);
}

// F) nothing stale: no-op
{
  const api = makeUiEnv({
    uiHost: { isConnected: true },
    floatingIcon: { isConnected: true }
  });
  check('F no stale refs -> false', api.dropStaleUiRefs() === false);
}

// G) host gone: uiHost/uiRoot reset
{
  const api = makeUiEnv({ uiHost: { isConnected: false }, uiRoot: {} });
  check('G reports dropped host', api.dropStaleUiRefs() === true);
  const s = api.get();
  check('G uiHost reset', s.uiHost === null);
  check('G uiRoot reset', s.uiRoot === null);
}

// H) showFloatingIcon rebuilds a detached icon (the reported symptom)
{
  const api = makeUiEnv({
    uiHost: { isConnected: true },
    floatingIcon: { isConnected: false, style: {} }
  });
  api.showFloatingIcon();
  const s = api.get();
  check('H stale icon replaced', s.floatingIcon && s.floatingIcon.isConnected === true);
  check('H new icon created once', s.created === 1);
  check('H icon is visible', s.floatingIcon.style.display === 'flex');
}

// I) showFloatingIcon keeps a live icon
{
  const liveIcon = { isConnected: true, style: {} };
  const api = makeUiEnv({ uiHost: { isConnected: true }, floatingIcon: liveIcon });
  api.showFloatingIcon();
  const s = api.get();
  check('I live icon reused', s.floatingIcon === liveIcon);
  check('I no rebuild', s.created === 0);
  check('I icon is visible', liveIcon.style.display === 'flex');
}

if (failed) { console.error(failed + ' check(s) failed'); process.exit(1); }
console.log('ALL TESTS PASSED');
