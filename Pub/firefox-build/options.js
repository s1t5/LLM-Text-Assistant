(function() {
  'use strict';

  // --- i18n helper ---

  function t(key, substitutions) {
    try {
      const msg = chrome.i18n.getMessage(key, substitutions);
      return msg || key;
    } catch (e) {
      return key;
    }
  }

  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      const msg = t(key);
      if (msg && msg !== key) {
        el.textContent = msg;
      }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const key = el.getAttribute('data-i18n-placeholder');
      const msg = t(key);
      if (msg && msg !== key) {
        el.placeholder = msg;
      }
    });
    document.title = t('optionsTitle');
  }

  // --- Shortcut helpers ---

  function serializeKeyboardEvent(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');

    let key = e.key;
    // Normalize some special keys
    const keyMap = {
      ' ': 'Space',
      'Control': 'Ctrl',
      'Alt': 'Alt',
      'Shift': 'Shift',
      'Meta': 'Meta',
      'ArrowUp': 'ArrowUp',
      'ArrowDown': 'ArrowDown',
      'ArrowLeft': 'ArrowLeft',
      'ArrowRight': 'ArrowRight',
      'Enter': 'Enter',
      'Escape': 'Escape',
      'Backspace': 'Backspace',
      'Delete': 'Delete',
      'Tab': 'Tab',
      'Home': 'Home',
      'End': 'End',
      'PageUp': 'PageUp',
      'PageDown': 'PageDown'
    };

    // Ignore pure modifier presses
    if (key === 'Control' || key === 'Alt' || key === 'Shift' || key === 'Meta') {
      return null;
    }

    if (keyMap[key] !== undefined) {
      key = keyMap[key];
    } else if (key.length === 1) {
      key = key.toUpperCase();
    }

    parts.push(key);
    return parts.join('+');
  }

  function parseShortcut(str) {
    if (!str || !str.trim()) return null;
    const parts = str.split('+');
    const result = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
    for (const part of parts) {
      const p = part.trim();
      const lower = p.toLowerCase();
      if (lower === 'ctrl') result.ctrl = true;
      else if (lower === 'alt') result.alt = true;
      else if (lower === 'shift') result.shift = true;
      else if (lower === 'meta' || lower === 'cmd') result.meta = true;
      else result.key = p;
    }
    return result.key ? result : null;
  }

  function formatShortcutForDisplay(str) {
    if (!str) return '';
    return str;
  }

  function attachShortcutCapture(input) {
    input.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const shortcut = serializeKeyboardEvent(e);
      if (shortcut) {
        input.value = shortcut;
        input.classList.remove('capturing');
        input.blur();
      }
    });

    input.addEventListener('focus', () => {
      input.classList.add('capturing');
      input.select();
    });

    input.addEventListener('blur', () => {
      input.classList.remove('capturing');
    });

    // Allow clearing with Backspace / Delete when focused
    input.addEventListener('keyup', (e) => {
      if (e.key === 'Backspace' || e.key === 'Delete') {
        input.value = '';
        input.classList.remove('capturing');
        input.blur();
      }
    });
  }

  // --- Constants ---

  function getDefaults() {
    return {
      apiUrl: "https://api.openai.com/v1/chat/completions",
      apiKey: "",
      model: "gpt-3.5-turbo",
      temperature: "0.3",
      timeoutSeconds: "60",
      targetLanguage: t("defaultTargetLanguage") || "English",
      promptTranslate: t("defaultPromptTranslate", t("defaultTargetLanguage") || "English"),
      promptExpand: t("defaultPromptExpand"),
      promptSummarize: t("defaultPromptSummarize"),
      promptGrammar: t("defaultPromptGrammar"),
      customActions: [],
      freePromptEnabled: true,
      builtinShortcuts: {},
      freePromptShortcut: ""
    };
  }

  const BUILTIN_FIELDS = [
    "apiUrl",
    "apiKey",
    "model",
    "temperature",
    "timeoutSeconds",
    "targetLanguage",
    "promptTranslate",
    "promptExpand",
    "promptSummarize",
    "promptGrammar",
    "customActions",
    "freePromptEnabled",
    "builtinShortcuts",
    "freePromptShortcut"
  ];

  // --- State ---

  let customActions = [];

  // --- DOM Helpers ---

  function $(id) { return document.getElementById(id); }

  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'style' && typeof v === 'object') {
        Object.assign(e.style, v);
      } else if (k === 'className') {
        e.className = v;
      } else if (k.startsWith('on')) {
        e.addEventListener(k.slice(2).toLowerCase(), v);
      } else {
        e.setAttribute(k, v);
      }
    }
    for (const child of children) {
      if (typeof child === 'string') {
        e.appendChild(document.createTextNode(child));
      } else if (child) {
        e.appendChild(child);
      }
    }
    return e;
  }

  // --- Custom Actions UI ---

  function renderCustomActions() {
    const list = $('customActionsList');
    list.innerHTML = '';

    customActions.forEach((action, index) => {
      const shortcutInput = el('input', {
        type: 'text',
        className: 'ca-shortcut shortcut-capture',
        value: action.shortcut || '',
        placeholder: t('shortcutPlaceholder'),
        readonly: 'readonly',
        onInput: () => syncCustomActionsFromDOM()
      });
      attachShortcutCapture(shortcutInput);

      const entry = el('div', { className: 'custom-action-entry' }, [
        el('div', { className: 'custom-action-header' }, [
          el('h3', {}, [t('optionsActionNumber', String(index + 1))]),
          el('button', {
            className: 'danger small',
            onClick: (e) => {
              e.preventDefault();
              customActions.splice(index, 1);
              renderCustomActions();
            }
          }, [t('optionsRemove')])
        ]),
        el('div', { className: 'custom-action-row' }, [
          el('label', {}, [t('optionsEmoji')]),
          el('input', {
            type: 'text',
            className: 'ca-emoji',
            value: action.emoji || '⚡',
            placeholder: '⚡',
            maxlength: '4',
            onInput: () => syncCustomActionsFromDOM()
          })
        ]),
        el('div', { className: 'custom-action-row' }, [
          el('label', {}, [t('optionsActionTitle')]),
          el('input', {
            type: 'text',
            className: 'ca-title',
            value: action.title || '',
            placeholder: t('optionsActionTitlePlaceholder'),
            maxlength: '40',
            onInput: () => syncCustomActionsFromDOM()
          })
        ]),
        el('div', { className: 'custom-action-row' }, [
          el('label', {}, [t('optionsPromptLabel')]),
          el('textarea', {
            className: 'ca-prompt',
            placeholder: t('optionsPromptPlaceholder'),
            rows: '3',
            onInput: () => syncCustomActionsFromDOM()
          }, [action.prompt || ''])
        ]),
        el('div', { className: 'custom-action-row' }, [
          el('label', {}, [t('optionsShortcutForAction')]),
          shortcutInput
        ]),
        el('div', { className: 'toggle-row' }, [
          el('span', { className: 'toggle-label' }, [t('optionsShowInContextMenu')]),
          el('label', { className: 'toggle-switch' }, [
            el('input', {
              type: 'checkbox',
              className: 'ca-contextmenu',
              checked: action.showInContextMenu !== false,
              onChange: () => syncCustomActionsFromDOM()
            }),
            el('span', { className: 'toggle-slider' })
          ])
        ])
      ]);

      list.appendChild(entry);
    });
  }

  function syncCustomActionsFromDOM() {
    const entries = document.querySelectorAll('#customActionsList .custom-action-entry');
    const actions = [];
    entries.forEach(entry => {
      const emojiInput = entry.querySelector('.ca-emoji');
      const titleInput = entry.querySelector('.ca-title');
      const promptArea = entry.querySelector('.ca-prompt');
      const contextCheckbox = entry.querySelector('.ca-contextmenu');
      const shortcutInput = entry.querySelector('.ca-shortcut');

      actions.push({
        emoji: emojiInput ? emojiInput.value.trim() || '⚡' : '⚡',
        title: titleInput ? titleInput.value.trim() : '',
        prompt: promptArea ? promptArea.value : '',
        showInContextMenu: contextCheckbox ? contextCheckbox.checked : true,
        shortcut: shortcutInput ? shortcutInput.value.trim() : ''
      });
    });
    customActions = actions;
  }

  function addNewAction() {
    customActions.push({
      emoji: '⚡',
      title: '',
      prompt: '',
      showInContextMenu: true,
      shortcut: ''
    });
    renderCustomActions();
  }

  // --- Lifecycle ---

  document.addEventListener("DOMContentLoaded", () => {
    applyI18n();
    restoreOptions();

    $("saveBtn").addEventListener("click", saveOptions);
    $("resetBtn").addEventListener("click", resetOptions);
    $("addActionBtn").addEventListener("click", (e) => {
      e.preventDefault();
      addNewAction();
    });

    // Attach shortcut capture to built-in shortcut fields
    const builtinShortcutIds = ['shortcutTranslate', 'shortcutExpand', 'shortcutSummarize', 'shortcutGrammar', 'shortcutFreePrompt'];
    for (const id of builtinShortcutIds) {
      const input = $(id);
      if (input) attachShortcutCapture(input);
    }
  });

  // --- Restore ---

  function restoreOptions() {
    const DEFAULTS = getDefaults();
    chrome.storage.sync.get(BUILTIN_FIELDS, (result) => {
      // Built-in fields
      for (const key of BUILTIN_FIELDS) {
        if (key === 'customActions') continue; // handled separately
        if (key === 'freePromptEnabled') {
          const cb = $('freePromptEnabled');
          if (cb) cb.checked = result[key] !== undefined ? result[key] : DEFAULTS[key];
          continue;
        }
        if (key === 'builtinShortcuts') {
          const shortcuts = result[key] && typeof result[key] === 'object' ? result[key] : {};
          const map = {
            shortcutTranslate: 'translate',
            shortcutExpand: 'expand',
            shortcutSummarize: 'summarize',
            shortcutGrammar: 'grammar'
          };
          for (const [inputId, actionId] of Object.entries(map)) {
            const input = $(inputId);
            if (input) input.value = shortcuts[actionId] || '';
          }
          continue;
        }
        if (key === 'freePromptShortcut') {
          const input = $('shortcutFreePrompt');
          if (input) input.value = result[key] !== undefined ? result[key] : '';
          continue;
        }
        const el = $(key);
        if (el) {
          el.value = result[key] !== undefined ? result[key] : DEFAULTS[key];
        }
      }

      // Custom actions
      customActions = Array.isArray(result.customActions) && result.customActions.length > 0
        ? JSON.parse(JSON.stringify(result.customActions))
        : [];
      renderCustomActions();
    });
  }

  // --- Save ---

  function saveOptions() {
    syncCustomActionsFromDOM();
    const DEFAULTS = getDefaults();

    const values = {};
    for (const key of BUILTIN_FIELDS) {
      if (key === 'customActions') {
        values[key] = customActions.filter(a => a.title.trim() !== '');
        continue;
      }
      if (key === 'freePromptEnabled') {
        const cb = $('freePromptEnabled');
        values[key] = cb ? cb.checked : DEFAULTS[key];
        continue;
      }
      if (key === 'builtinShortcuts') {
        values[key] = {
          translate: $('shortcutTranslate') ? $('shortcutTranslate').value.trim() : '',
          expand: $('shortcutExpand') ? $('shortcutExpand').value.trim() : '',
          summarize: $('shortcutSummarize') ? $('shortcutSummarize').value.trim() : '',
          grammar: $('shortcutGrammar') ? $('shortcutGrammar').value.trim() : ''
        };
        // Remove empty shortcuts
        for (const k of Object.keys(values[key])) {
          if (!values[key][k]) delete values[key][k];
        }
        continue;
      }
      if (key === 'freePromptShortcut') {
        const input = $('shortcutFreePrompt');
        values[key] = input ? input.value.trim() : '';
        continue;
      }
      const el = $(key);
      values[key] = el ? el.value.trim() : "";
    }

    chrome.storage.sync.set(values, () => {
      if (chrome.runtime.lastError) {
        showStatus(t('optionsSaveError') + chrome.runtime.lastError.message, "error");
        return;
      }
      showStatus(t('optionsSaved'), "success");
    });
  }

  // --- Reset ---

  function resetOptions() {
    if (!confirm(t('optionsResetConfirm'))) {
      return;
    }

    chrome.storage.sync.clear(() => {
      if (chrome.runtime.lastError) {
        showStatus(t('optionsResetError') + chrome.runtime.lastError.message, "error");
        return;
      }
      customActions = [];
      restoreOptions();
      showStatus(t('optionsResetDone'), "success");
    });
  }

  // --- Status ---

  function showStatus(message, type) {
    const statusEl = $("status");
    statusEl.textContent = message;
    statusEl.className = type;

    setTimeout(() => {
      statusEl.textContent = "";
      statusEl.className = "";
    }, 3000);
  }
})();
