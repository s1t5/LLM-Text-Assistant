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
    document.title = t('optionsTitle');
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
      freePromptEnabled: true
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
    "freePromptEnabled"
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

      actions.push({
        emoji: emojiInput ? emojiInput.value.trim() || '⚡' : '⚡',
        title: titleInput ? titleInput.value.trim() : '',
        prompt: promptArea ? promptArea.value : '',
        showInContextMenu: contextCheckbox ? contextCheckbox.checked : true
      });
    });
    customActions = actions;
  }

  function addNewAction() {
    customActions.push({
      emoji: '⚡',
      title: '',
      prompt: '',
      showInContextMenu: true
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
