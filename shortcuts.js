// LLM Text Assistant — early shortcut guard (document_start).
//
// Injected at document_start, i.e. BEFORE any page script runs, into every
// frame. That makes this file the FIRST listener on `window` in the capture
// phase — the earliest position in the event propagation path. Window-capture
// listeners run before document/element handlers, and within one node the
// registration order decides, so being first on `window` beats page shortcut
// handlers regardless of whether they listen on `window`, on `document`, in
// the capture or in the bubble phase, or call stopImmediatePropagation()
// themselves.
//
// This file only owns the SWALLOWING; the DECISION stays in content.js, which
// owns the action config and the field resolution. Once initialised, content.js
// installs `globalThis.__llmShortcutGuard` (same isolated world → plain
// global), a function that returns the matched shortcut string when the event
// is one of the add-in's shortcuts while a text field is focused, and null
// otherwise. Only a truthy result makes the guard consume the event:
//
//   * keydown is swallowed → the page never sees the combination at all, and
//     the browser's own default action for it is cancelled as well.
//   * the matching keyup is swallowed too, so pages that implement shortcuts
//     on keyup (Mousetrap-style handlers, editors with keyup shortcuts) cannot
//     run their action either.
//
// Until content.js has installed the hook (a few milliseconds after
// document_start) the guard is a no-op, so nothing is ever swallowed that the
// add-in could not also act on.
(function () {
  'use strict';

  const HOOK = '__llmShortcutGuard';

  // Combination whose keydown we already consumed → swallow its keyup too.
  let swallowedCombo = null;

  function comboOf(e) {
    return {
      ctrl: e.ctrlKey === true,
      alt: e.altKey === true,
      shift: e.shiftKey === true,
      meta: e.metaKey === true,
      key: e.key
    };
  }

  function sameCombo(combo, e) {
    return !!combo &&
      combo.ctrl === (e.ctrlKey === true) &&
      combo.alt === (e.altKey === true) &&
      combo.shift === (e.shiftKey === true) &&
      combo.meta === (e.metaKey === true) &&
      combo.key === e.key;
  }

  function consume(e) {
    e.preventDefault();
    // stopImmediatePropagation (not just stopPropagation) is what also
    // silences listeners registered on the SAME node before ours — a page
    // listening on window/document capture included.
    e.stopImmediatePropagation();
    e.stopPropagation();
  }

  function onKeydown(e) {
    const hook = globalThis[HOOK];
    if (typeof hook !== 'function') return;

    let combo = null;
    try {
      combo = hook(e);
    } catch (err) {
      // A broken hook must never block the page's own shortcuts.
      return;
    }
    if (!combo) return;

    swallowedCombo = comboOf(e);
    consume(e);
  }

  function onKeyup(e) {
    if (!sameCombo(swallowedCombo, e)) return;
    swallowedCombo = null;
    consume(e);
  }

  // Focus left the frame (e.g. Alt+Tab between keydown and keyup) → the
  // remembered combination can no longer produce a matching keyup.
  function reset() {
    swallowedCombo = null;
  }

  window.addEventListener('keydown', onKeydown, true);
  window.addEventListener('keyup', onKeyup, true);
  window.addEventListener('blur', reset);
})();
