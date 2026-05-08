// Default configuration
const DEFAULT_CONFIG = {
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

const ALL_KEYS = Object.keys(DEFAULT_CONFIG);

// Promise wrappers for Chrome storage API
function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.sync.get(keys, (result) => resolve(result));
  });
}

function storageSet(values) {
  return new Promise((resolve) => {
    chrome.storage.sync.set(values, () => resolve());
  });
}

// --- Built-in action definitions ---
const BUILTIN_ACTIONS = [
  { id: "translate", title: "🌐 Ins Englische übersetzen" },
  { id: "expand", title: "✍️ Ausformulieren" },
  { id: "summarize", title: "📋 Zusammenfassen" },
  { id: "grammar", title: "✅ Rechtschreibung & Grammatik" }
];

// --- Context Menu Management ---

async function rebuildContextMenus() {
  const config = await storageGet(ALL_KEYS);
  const customActions = Array.isArray(config.customActions) ? config.customActions : [];

  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {
      console.error("removeAll error:", chrome.runtime.lastError);
    }

    // Parent menu
    chrome.contextMenus.create({
      id: "llm-parent",
      title: "LLM Text Assistent",
      contexts: ["editable", "selection"]
    }, () => {
      if (chrome.runtime.lastError) {
        console.error("create parent error:", chrome.runtime.lastError);
      }

      // Built-in actions always present
      for (const action of BUILTIN_ACTIONS) {
        chrome.contextMenus.create({
          id: action.id,
          parentId: "llm-parent",
          title: action.title,
          contexts: ["editable", "selection"]
        });
      }

      // Custom actions that have showInContextMenu enabled
      customActions.forEach((action, index) => {
        if (action.showInContextMenu !== false && action.title && action.title.trim()) {
          const emoji = action.emoji || '⚡';
          chrome.contextMenus.create({
            id: `custom_${index}`,
            parentId: "llm-parent",
            title: `${emoji} ${action.title}`,
            contexts: ["editable", "selection"]
          });
        }
      });
    });
  });
}

// Initialize on install
chrome.runtime.onInstalled.addListener(() => {
  storageGet(ALL_KEYS).then((result) => {
    const updates = {};
    for (const key of ALL_KEYS) {
      if (result[key] === undefined) {
        updates[key] = DEFAULT_CONFIG[key];
      }
    }
    if (Object.keys(updates).length > 0) {
      return storageSet(updates);
    }
  }).then(() => {
    rebuildContextMenus();
  }).catch((err) => console.error("Initialization error:", err));
});

// Rebuild context menus when storage changes (e.g., user saves settings)
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && (changes.customActions || changes.freePromptEnabled)) {
    rebuildContextMenus();
  }
});

// Also rebuild on startup
chrome.runtime.onStartup.addListener(() => {
  rebuildContextMenus();
});

// --- Message Handling ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "processFullText") {
    if (!sender.tab) {
      console.error("[LLM] sender.tab is undefined!");
      sendResponse({ success: false, error: "sender.tab is undefined" });
      return;
    }
    processText(request.textAction, request.text, sender.tab, true)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async response
  }

  if (request.action === "processFreePrompt") {
    if (!sender.tab) {
      console.error("[LLM] sender.tab is undefined!");
      sendResponse({ success: false, error: "sender.tab is undefined" });
      return;
    }
    processFreePrompt(request.messages, sender.tab)
      .then((processedText) => sendResponse({ success: true, text: processedText }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "loadActions") {
    loadActionsForContent()
      .then((actions) => sendResponse({ success: true, actions }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// --- Context Menu Click Handler ---

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // Determine action type
  const isBuiltin = ["translate", "expand", "summarize", "grammar"].includes(info.menuItemId);
  const isCustom = info.menuItemId.startsWith("custom_");

  if (!isBuiltin && !isCustom) return;

  let selectedText = info.selectionText || "";
  
  // Try to get better formatted text with line breaks via executeScript
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection().toString()
    });
    if (results && results[0] && results[0].result) {
      selectedText = results[0].result;
    }
  } catch (e) {
    console.warn("Could not execute script to get selection, falling back to selectionText");
  }

  if (!selectedText.trim()) {
    console.warn("No text selected");
    return;
  }

  await processText(info.menuItemId, selectedText, tab);
});

// --- Core: Process text with a given action ID ---

async function processText(action, text, tab, isFullText = false) {
  try {
    if (!tab || !tab.id) {
      throw new Error("Tab information missing");
    }
    
    const config = await storageGet(ALL_KEYS);

    let systemPrompt = '';
    const builtinPromptMap = {
      translate: config.promptTranslate || DEFAULT_CONFIG.promptTranslate,
      expand: config.promptExpand || DEFAULT_CONFIG.promptExpand,
      summarize: config.promptSummarize || DEFAULT_CONFIG.promptSummarize,
      grammar: config.promptGrammar || DEFAULT_CONFIG.promptGrammar
    };

    if (action.startsWith('custom_')) {
      const customIndex = parseInt(action.replace('custom_', ''), 10);
      const customActions = Array.isArray(config.customActions) ? config.customActions : [];
      if (customIndex >= 0 && customIndex < customActions.length) {
        systemPrompt = customActions[customIndex].prompt || '';
      }
      if (!systemPrompt.trim()) {
        throw new Error("Custom action has no prompt defined.");
      }
    } else {
      systemPrompt = builtinPromptMap[action];
    }

    // Embed the text inside a system-level instruction so the LLM treats it
    // as input material rather than a conversational user message.
    const fullSystemPrompt = `${systemPrompt}

--- ZU VERARBEITENDER TEXT (keine Chat-Nachricht!) ---
${text}
--- ENDE TEXT ---

Verarbeite den obigen Text strikt gemäß der obigen Anweisung. Gib NUR das Ergebnis aus, ohne Einleitung, Erklärung oder sonstige Zusätze.`;

    const messages = [
      { role: "system", content: fullSystemPrompt },
      { role: "user", content: "Verarbeite den Text." }
    ];

    const requestBody = {
      model: config.model || DEFAULT_CONFIG.model,
      messages: messages,
      temperature: parseFloat(config.temperature || DEFAULT_CONFIG.temperature)
    };

    const response = await fetch(config.apiUrl || DEFAULT_CONFIG.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {})
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API Fehler ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    if (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
      const processedText = data.choices[0].message.content;

      const messageAction = isFullText ? "replaceFullText" : "replaceText";
      
      chrome.tabs.sendMessage(tab.id, {
        action: messageAction,
        text: processedText
      }, () => {
        if (chrome.runtime.lastError) {
          // Content script might not be ready; fallback to executeScript
          console.warn("Content script not available, using fallback");
          injectReplacement(tab.id, processedText, messageAction === "replaceFullText");
        }
      });
    } else {
      throw new Error("Ungültige API-Antwort");
    }
  } catch (error) {
    console.error("LLM API Fehler:", error);
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, {
        action: "showError",
        message: error.message
      }, () => {
        if (chrome.runtime.lastError) {
          console.error("Could not notify content script:", chrome.runtime.lastError);
        }
      });
    }
  }
}

// --- Free Prompt: Multi-turn chat-style processing ---

async function processFreePrompt(messages, tab) {
  if (!tab || !tab.id) {
    throw new Error("Tab information missing");
  }

  const config = await storageGet(ALL_KEYS);

  const requestBody = {
    model: config.model || DEFAULT_CONFIG.model,
    messages: messages,
    temperature: parseFloat(config.temperature || DEFAULT_CONFIG.temperature)
  };

  const response = await fetch(config.apiUrl || DEFAULT_CONFIG.apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {})
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API Fehler ${response.status}: ${errorText}`);
  }

  const data = await response.json();

  if (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
    return data.choices[0].message.content;
  } else {
    throw new Error("Ungültige API-Antwort");
  }
}

// --- Load actions for content script ---

async function loadActionsForContent() {
  const config = await storageGet(ALL_KEYS);
  const customActions = Array.isArray(config.customActions) ? config.customActions : [];
  const freePromptEnabled = config.freePromptEnabled !== undefined
    ? config.freePromptEnabled
    : DEFAULT_CONFIG.freePromptEnabled;

  return {
    builtin: BUILTIN_ACTIONS,
    custom: customActions.filter(a => a.title && a.title.trim()),
    freePromptEnabled: freePromptEnabled
  };
}

// --- Fallback: inject replacement code directly if content script is unreachable ---

function injectReplacement(tabId, replacementText, replaceFull = false) {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (newText, fullReplace) => {
      const activeElement = document.activeElement;
      if (!activeElement) return;

      if (activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA") {
        const el = activeElement;
        if (fullReplace) {
          el.value = newText;
          el.selectionStart = el.selectionEnd = newText.length;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          const start = el.selectionStart;
          const end = el.selectionEnd;
          if (start !== undefined && end !== undefined && start !== end) {
            const original = el.value;
            el.value = original.substring(0, start) + newText + original.substring(end);
            const newCursor = start + newText.length;
            el.setSelectionRange(newCursor, newCursor);
            el.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      } else if (activeElement.isContentEditable) {
        if (fullReplace) {
          activeElement.innerText = newText;
          activeElement.dispatchEvent(new Event("input", { bubbles: true }));
        } else {
          const selection = window.getSelection();
          if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            range.deleteContents();

            // Insert new text, handling newlines as <br> in contenteditable
            const lines = newText.split("\n");
            let lastNode = null;
            
            lines.forEach((line, index) => {
              if (line) {
                const textNode = document.createTextNode(line);
                range.insertNode(textNode);
                lastNode = textNode;
                range.setStartAfter(textNode);
                range.setEndAfter(textNode);
              }
              
              if (index < lines.length - 1) {
                const br = document.createElement("br");
                range.insertNode(br);
                lastNode = br;
                range.setStartAfter(br);
                range.setEndAfter(br);
              }
            });

            if (lastNode) {
              range.setStartAfter(lastNode);
              range.setEndAfter(lastNode);
            }
            selection.removeAllRanges();
            selection.addRange(range);
            activeElement.dispatchEvent(new Event("input", { bubbles: true }));
          }
        }
      }
    },
    args: [replacementText, replaceFull]
  });
}