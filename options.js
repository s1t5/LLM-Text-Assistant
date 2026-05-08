(function() {
  'use strict';

  // --- Constants ---

  const DEFAULTS = {
    apiUrl: "https://api.openai.com/v1/chat/completions",
    apiKey: "",
    model: "gpt-3.5-turbo",
    temperature: "0.3",
    promptTranslate: "Du bist ein Übersetzungs-Werkzeug. Übersetze den unterhalb markierten Text ins Englische. Behalte die Formatierung, Absätze und Zeilenumbrüche genau bei. Gib NUR die Übersetzung aus – keine Einleitung, keine Erklärung, keine Meta-Kommentare.",
    promptExpand: "Du bist ein Text-Werkzeug. Formuliere die unterhalb markierten Stichpunkte oder Satzfragmente zu einem vollständigen, flüssigen Text aus. Behalte die Formatierung, Absätze und Zeilenumbrüche bei. Gib NUR den ausformulierten Text aus – keine Einleitung, keine Erklärung, keine Meta-Kommentare.",
    promptSummarize: "Du bist ein Zusammenfassungs-Werkzeug. Fasse den unterhalb markierten Text kurz und prägnant zusammen. Behalte die Formatierung, Absätze und Zeilenumbrüche bei. Gib NUR die Zusammenfassung aus – keine Einleitung, keine Erklärung, keine Meta-Kommentare.",
    promptGrammar: "Du bist ein Korrektur-Werkzeug. Korrigiere Rechtschreibung, Grammatik und Zeichensetzung im unterhalb markierten Text. Behalte die Formatierung, Absätze und Zeilenumbrüche bei. Gib NUR den korrigierten Text aus – keine Einleitung, keine Erklärung, keine Meta-Kommentare.",
    customActions: [],
    freePromptEnabled: true
  };

  const BUILTIN_FIELDS = [
    "apiUrl",
    "apiKey",
    "model",
    "temperature",
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
          el('h3', {}, [`Aktion #${index + 1}`]),
          el('button', {
            className: 'danger small',
            onClick: (e) => {
              e.preventDefault();
              customActions.splice(index, 1);
              renderCustomActions();
            }
          }, ['🗑 Entfernen'])
        ]),
        el('div', { className: 'custom-action-row' }, [
          el('label', {}, ['Emoji']),
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
          el('label', {}, ['Titel']),
          el('input', {
            type: 'text',
            className: 'ca-title',
            value: action.title || '',
            placeholder: 'Aktionstitel',
            maxlength: '40',
            onInput: () => syncCustomActionsFromDOM()
          })
        ]),
        el('div', { className: 'custom-action-row' }, [
          el('label', {}, ['Prompt']),
          el('textarea', {
            className: 'ca-prompt',
            placeholder: 'System-Prompt für diese Aktion...',
            rows: '3',
            onInput: () => syncCustomActionsFromDOM()
          }, [action.prompt || ''])
        ]),
        el('div', { className: 'toggle-row' }, [
          el('span', { className: 'toggle-label' }, ['Im Kontextmenü anzeigen']),
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
    chrome.storage.sync.get(BUILTIN_FIELDS, (result) => {
      // Built-in fields
      for (const key of BUILTIN_FIELDS) {
        if (key === 'customActions') continue; // handled separately
        if (key === 'freePromptEnabled') {
          const el = $('freePromptEnabled');
          if (el) el.checked = result[key] !== undefined ? result[key] : DEFAULTS[key];
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
        showStatus("Fehler beim Speichern: " + chrome.runtime.lastError.message, "error");
        return;
      }
      showStatus("✅ Einstellungen gespeichert!", "success");
    });
  }

  // --- Reset ---

  function resetOptions() {
    if (!confirm("Möchtest du wirklich alle Einstellungen auf die Standardwerte zurücksetzen?")) {
      return;
    }

    chrome.storage.sync.clear(() => {
      if (chrome.runtime.lastError) {
        showStatus("Fehler beim Zurücksetzen: " + chrome.runtime.lastError.message, "error");
        return;
      }
      customActions = [];
      restoreOptions();
      showStatus("✅ Standardwerte wiederhergestellt.", "success");
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