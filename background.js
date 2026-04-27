// Default configuration
const DEFAULT_CONFIG = {
  apiUrl: "https://api.openai.com/v1/chat/completions",
  apiKey: "",
  model: "gpt-3.5-turbo",
  temperature: "0.3",
  promptTranslate: "Übersetze den folgenden Text ins Englische. Behalte die Formatierung, Absätze und Zeilenumbrüche genau bei. Antworte nur mit der Übersetzung, ohne zusätzliche Erklärungen:",
  promptExpand: "Formuliere die folgenden Stichpunkte oder Satzfragmente zu einem vollständigen, flüssigen Text aus. Behalte die Formatierung, Absätze und Zeilenumbrüche bei. Antworte nur mit dem ausformulierten Text:",
  promptSummarize: "Fasse den folgenden Text kurz und prägnant zusammen. Behalte die Formatierung, Absätze und Zeilenumbrüche bei. Antworte nur mit der Zusammenfassung:",
  promptGrammar: "Korrigiere Rechtschreibung, Grammatik und Zeichensetzung im folgenden Text. Behalte die Formatierung, Absätze und Zeilenumbrüche bei. Antworte nur mit dem korrigierten Text:"
};

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

// Initialize on install
chrome.runtime.onInstalled.addListener(() => {
  storageGet(Object.keys(DEFAULT_CONFIG)).then((result) => {
    const updates = {};
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (result[key] === undefined) {
        updates[key] = DEFAULT_CONFIG[key];
      }
    }
    if (Object.keys(updates).length > 0) {
      return storageSet(updates);
    }
  }).then(() => {
    createContextMenus();
  }).catch((err) => console.error("Initialization error:", err));
});

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "llm-parent",
      title: "LLM Text Assistent",
      contexts: ["editable", "selection"]
    }, () => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError);
      }

      const actions = [
        { id: "translate", title: "🌐 Ins Englische übersetzen" },
        { id: "expand", title: "✍️ Ausformulieren" },
        { id: "summarize", title: "📋 Zusammenfassen" },
        { id: "grammar", title: "✅ Rechtschreibung & Grammatik" }
      ];

      for (const action of actions) {
        chrome.contextMenus.create({
          id: action.id,
          parentId: "llm-parent",
          title: action.title,
          contexts: ["editable", "selection"]
        });
      }
    });
  });
}

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
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!["translate", "expand", "summarize", "grammar"].includes(info.menuItemId)) return;

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

async function processText(action, text, tab, isFullText = false) {
  try {
    if (!tab || !tab.id) {
      throw new Error("Tab information missing");
    }
    
    const config = await storageGet(Object.keys(DEFAULT_CONFIG));

    const promptMap = {
      translate: config.promptTranslate || DEFAULT_CONFIG.promptTranslate,
      expand: config.promptExpand || DEFAULT_CONFIG.promptExpand,
      summarize: config.promptSummarize || DEFAULT_CONFIG.promptSummarize,
      grammar: config.promptGrammar || DEFAULT_CONFIG.promptGrammar
    };

    const systemPrompt = promptMap[action];

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: text }
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

// Fallback: inject replacement code directly if content script is unreachable
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
