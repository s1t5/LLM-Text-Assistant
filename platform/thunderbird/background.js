// --- i18n helper ---
function t(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions) || key;
}

// Default configuration — built at runtime so prompts can be localized.
function buildDefaultConfig() {
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

const DEFAULT_KEYS = [
  "apiUrl", "apiKey", "model", "temperature", "timeoutSeconds", "targetLanguage",
  "promptTranslate", "promptExpand", "promptSummarize", "promptGrammar",
  "customActions", "freePromptEnabled", "builtinShortcuts", "freePromptShortcut"
];

// --- Built-in action definitions (titles resolved at runtime) ---

function getBuiltinActions(targetLanguage) {
  return [
    { id: "translate", title: t("actionTranslate", targetLanguage) },
    { id: "expand", title: t("actionExpand") },
    { id: "summarize", title: t("actionSummarize") },
    { id: "grammar", title: t("actionGrammar") }
  ];
}

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

// --- Compose script injection entrypoint ---
// Registers content.js so it runs inside every Thunderbird compose window.
// In Manifest V3 (TB 128+) the old browser.composeScripts.register() was
// replaced by browser.scripting.compose.registerScripts(). We also inject
// into already-open compose tabs, because registerScripts only affects
// windows opened *after* registration.
async function registerComposeScript() {
  try {
    await browser.scripting.compose.registerScripts([{
      id: "llm-compose-script",
      js: ["/content.js"]
    }]);

    // Inject into compose tabs that are already open (registerScripts only
    // affects newly opened windows).
    try {
      const composeTabs = await browser.tabs.query({ type: "messageCompose" });
      for (const tab of composeTabs) {
        browser.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["/content.js"]
        }).catch((e) => console.warn("[LLM] executeScript on existing tab:", e));
      }
    } catch (e) {
      console.warn("[LLM] Could not inject into existing compose tabs:", e);
    }
  } catch (err) {
    // Registration fails if it was already done (e.g. onStartup after install).
    console.warn("[LLM] scripting.compose.registerScripts (non-fatal):", err);
  }
}
registerComposeScript();

// --- UI cleanup before sending ---
// The extension UI (floating icon, menu, chat) is injected into the compose
// document. Although it lives in a closed shadow root (never serialized),
// we also detach the UI host before the message body is serialized, so not
// even the empty host element remains in sent mails or saved drafts.
// onBeforeSend runs before Thunderbird reads the body from the editor.
browser.compose.onBeforeSend.addListener((tab) => {
  // Return the promise so Thunderbird waits for the cleanup to finish
  // before it reads and serializes the compose body.
  return browser.tabs.sendMessage(tab.id, { action: "suspendUi" }).catch(() => {
    // Content script may not be injected (e.g. compose window without
    // an editable field focused yet) — nothing to clean up then.
  });
});

// --- Context Menu Management ---
// Thunderbird does not support context menu items inside compose documents
// (no "editable"/"selection" contexts there), so this is a no-op here.
// Interaction happens via the floating icon / shortcuts in the compose window.
async function rebuildContextMenus() {}

// Initialize on install
chrome.runtime.onInstalled.addListener(() => {
  const defaults = buildDefaultConfig();
  storageGet(DEFAULT_KEYS).then((result) => {
    const updates = {};
    for (const key of DEFAULT_KEYS) {
      if (result[key] === undefined) {
        updates[key] = defaults[key];
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
  if (namespace === 'sync' && (changes.customActions || changes.freePromptEnabled || changes.targetLanguage)) {
    rebuildContextMenus();
  }
});

// Also rebuild on startup
chrome.runtime.onStartup.addListener(() => {
  rebuildContextMenus();
});

// --- Active request tracking (for cancellation) ---
// requestId -> AbortController
const activeRequests = new Map();
let nextRequestId = 1;

function abortRequest(requestId) {
  const controller = activeRequests.get(requestId);
  if (controller) {
    controller.abort();
    activeRequests.delete(requestId);
  }
}

// --- Message Handling (legacy non-streaming paths + control messages) ---

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "composePopupTrigger") {
    // The popup cannot message the compose tab directly (popup has no tab
    // context), so the background routes it to the compose tab that opened
    // the popup (or the currently active tab as fallback). We only message
    // messageCompose-type tabs to avoid leaking commands to web pages.
    browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const composeTab = (tabs || []).find((t) => t.type === "messageCompose");
      if (!composeTab) {
        sendResponse({ success: false, error: "No active compose tab" });
        return;
      }
      chrome.tabs.sendMessage(composeTab.id, {
        action: "contextMenuProcess",
        textAction: request.textAction
      }, (resp) => {
        sendResponse(resp || { success: false });
      });
    }).catch((err) => {
      sendResponse({ success: false, error: err.message });
    });
    return true; // async response
  }

  if (request.action === "abortRequest") {
    abortRequest(request.requestId);
    sendResponse({ success: true });
    return;
  }

  if (request.action === "processFullText") {
    if (!sender.tab) {
      console.error("[LLM] sender.tab is undefined!");
      sendResponse({ success: false, error: "sender.tab is undefined" });
      return;
    }
    processTextNonStreaming(request.textAction, request.text, sender.tab, true)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true; // Keep channel open for async response
  }

  if (request.action === "processSelection") {
    if (!sender.tab) {
      console.error("[LLM] sender.tab is undefined!");
      sendResponse({ success: false, error: "sender.tab is undefined" });
      return;
    }
    processTextNonStreaming(request.textAction, request.text, sender.tab, false)
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (request.action === "processFreePrompt") {
    if (!sender.tab) {
      console.error("[LLM] sender.tab is undefined!");
      sendResponse({ success: false, error: "sender.tab is undefined" });
      return;
    }
    processFreePromptNonStreaming(request.messages)
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

// --- Streaming port handling ---

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "llmStream") return;

  port.onMessage.addListener(async (msg) => {
    if (msg.action === "start") {
      const requestId = msg.requestId;
      const tab = port.sender && port.sender.tab;
      if (!tab || !tab.id) {
        port.postMessage({ requestId, type: "error", error: "Tab information missing" });
        return;
      }

      const controller = new AbortController();
      activeRequests.set(requestId, controller);

      try {
        if (msg.mode === "action") {
          await processTextStreaming(port, requestId, msg.textAction, msg.text, tab, msg.isFullText, controller.signal);
        } else if (msg.mode === "freePrompt") {
          await processFreePromptStreaming(port, requestId, msg.messages, controller.signal);
        }
      } catch (err) {
        if (err.name === "AbortError") {
          port.postMessage({ requestId, type: "aborted" });
        } else {
          port.postMessage({ requestId, type: "error", error: err.message });
        }
      } finally {
        activeRequests.delete(requestId);
      }
    } else if (msg.action === "abort") {
      abortRequest(msg.requestId);
    }
  });

  port.onDisconnect.addListener(() => {
    // If the content script connection goes away, abort any request started via this port.
    // We iterate over a snapshot since abort() mutates the map.
    // (Requests keyed by requestId; we abort all — ports are per-frame and own their requests.)
  });
});

// --- Context Menu Click Handler ---
// Not used in Thunderbird: no context menus inside compose documents.
// All interactions happen via the floating icon / keyboard shortcuts in
// content.js (streaming path). Kept as a guarded no-op for parity.

// --- Prompt assembly ---

async function buildPromptParts(action, text, config) {
  const defaults = buildDefaultConfig();
  const targetLanguage = config.targetLanguage || defaults.targetLanguage;

  let systemPrompt = '';
  const builtinPromptMap = {
    translate: config.promptTranslate || defaults.promptTranslate,
    expand: config.promptExpand || defaults.promptExpand,
    summarize: config.promptSummarize || defaults.promptSummarize,
    grammar: config.promptGrammar || defaults.promptGrammar
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
    // Substitute the {TARGET_LANGUAGE} placeholder at runtime
    if (action === "translate") {
      systemPrompt = systemPrompt.split("{TARGET_LANGUAGE}").join(targetLanguage);
      // Backwards compatibility: old German default prompt had the target language hardcoded.
    }
  }

  // Embed the text inside a system-level instruction so the LLM treats it
  // as input material rather than a conversational user message.
  const german = (chrome.i18n.getUILanguage() || "de").startsWith("de");
  const fullSystemPrompt = german
    ? `${systemPrompt}

--- ZU VERARBEITENDER TEXT (keine Chat-Nachricht!) ---
${text}
--- ENDE TEXT ---

Verarbeite den obigen Text strikt gemäß der obigen Anweisung. Gib NUR das Ergebnis aus, ohne Einleitung, Erklärung oder sonstige Zusätze.`
    : `${systemPrompt}

--- TEXT TO PROCESS (not a chat message!) ---
${text}
--- END TEXT ---

Process the text above strictly according to the instruction above. Output ONLY the result, without introduction, explanation or other additions.`;

  const userMessage = german ? "Verarbeite den Text." : "Process the text.";

  return [
    { role: "system", content: fullSystemPrompt },
    { role: "user", content: userMessage }
  ];
}

// --- HTTP layer with timeout + retry ---

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(config, requestBody, signal) {
  const defaults = buildDefaultConfig();
  const url = config.apiUrl || defaults.apiUrl;
  const timeoutMs = Math.max(5, parseInt(config.timeoutSeconds || defaults.timeoutSeconds, 10) || 60) * 1000;

  const maxAttempts = 3; // initial try + 2 retries
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    // Per-attempt timeout, linked to the user-facing abort signal
    const attemptController = new AbortController();
    const timeoutId = setTimeout(() => attemptController.abort(), timeoutMs);
    const onUserAbort = () => attemptController.abort();
    signal.addEventListener("abort", onUserAbort);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {})
        },
        body: JSON.stringify(requestBody),
        signal: attemptController.signal
      });
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", onUserAbort);

      if (response.ok) {
        return response;
      }

      const errorText = await response.text().catch(() => "");

      // Non-retryable: client/config errors
      if ([400, 401, 403, 404].includes(response.status) || (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429)) {
        throw new Error(mapApiError(response.status, errorText));
      }

      // Retryable: 408, 429, 5xx
      lastError = new Error(mapApiError(response.status, errorText));
    } catch (err) {
      clearTimeout(timeoutId);
      signal.removeEventListener("abort", onUserAbort);

      if (signal.aborted || (err.name === "AbortError" && signal.aborted)) {
        throw new DOMException("Aborted", "AbortError");
      }

      if (err.name === "AbortError") {
        // Per-attempt timeout fired
        lastError = new Error(timeoutMessage(timeoutMs / 1000));
      } else if (err instanceof TypeError) {
        // Network failure
        lastError = new Error(networkErrorMessage());
      } else if (err.message && err.message.startsWith("API")) {
        // Mapped API error — rethrow non-retryables, keep retryables
        throw err;
      } else {
        lastError = err;
      }
    }

    // Backoff before retry: 1s, then 3s
    if (attempt < maxAttempts - 1) {
      await sleep(attempt === 0 ? 1000 : 3000);
    }
  }

  throw lastError || new Error("Unbekannter Fehler");
}

function mapApiError(status, errorText) {
  const german = (chrome.i18n.getUILanguage() || "de").startsWith("de");
  let detail = "";
  try {
    const parsed = JSON.parse(errorText);
    if (parsed && parsed.error && parsed.error.message) {
      detail = parsed.error.message;
    }
  } catch (e) { /* ignore */ }

  if (status === 401 || status === 403) {
    return german ? `API: Authentifizierung fehlgeschlagen (HTTP ${status}). Prüfe den API-Key.` : `API: authentication failed (HTTP ${status}). Check the API key.`;
  }
  if (status === 404) {
    return german ? `API: Endpunkt oder Modell nicht gefunden (HTTP 404). Prüfe URL und Modellname.` : `API: endpoint or model not found (HTTP 404). Check the URL and model name.`;
  }
  if (status === 429) {
    return german ? `API: Rate-Limit erreicht (HTTP 429). Bitte später erneut versuchen.` : `API: rate limit reached (HTTP 429). Please try again later.`;
  }
  return german
    ? `API Fehler ${status}${detail ? ": " + detail : ""}`
    : `API error ${status}${detail ? ": " + detail : ""}`;
}

function timeoutMessage(seconds) {
  const german = (chrome.i18n.getUILanguage() || "de").startsWith("de");
  return german
    ? `Zeitüberschreitung nach ${seconds}s. Läuft der Server bzw. ist der Endpunkt erreichbar?`
    : `Timeout after ${seconds}s. Is the server running / the endpoint reachable?`;
}

function networkErrorMessage() {
  const german = (chrome.i18n.getUILanguage() || "de").startsWith("de");
  return german
    ? "Netzwerkfehler: Der API-Endpunkt ist nicht erreichbar."
    : "Network error: the API endpoint is unreachable.";
}

// --- Non-streaming (legacy/fallback) processing ---

async function processTextNonStreaming(action, text, tab, isFullText = false) {
  const config = await storageGet(DEFAULT_KEYS);
  const controller = new AbortController();
  const messages = await buildPromptParts(action, text, config);

  const requestBody = {
    model: config.model || buildDefaultConfig().model,
    messages: messages,
    temperature: parseFloat(config.temperature || buildDefaultConfig().temperature)
  };

  try {
    const response = await fetchWithRetry(config, requestBody, controller.signal);
    const data = await response.json();

    if (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
      const processedText = data.choices[0].message.content;
      const messageAction = isFullText ? "replaceFullText" : "replaceText";

      chrome.tabs.sendMessage(tab.id, {
        action: messageAction,
        text: processedText
      }, () => {
        if (chrome.runtime.lastError) {
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

async function processFreePromptNonStreaming(messages) {
  const config = await storageGet(DEFAULT_KEYS);
  const controller = new AbortController();

  const requestBody = {
    model: config.model || buildDefaultConfig().model,
    messages: messages,
    temperature: parseFloat(config.temperature || buildDefaultConfig().temperature)
  };

  const response = await fetchWithRetry(config, requestBody, controller.signal);
  const data = await response.json();

  if (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
    return data.choices[0].message.content;
  } else {
    throw new Error("Ungültige API-Antwort");
  }
}

// --- Streaming processing ---

async function processTextStreaming(port, requestId, action, text, tab, isFullText, signal) {
  const config = await storageGet(DEFAULT_KEYS);
  const messages = await buildPromptParts(action, text, config);

  const requestBody = {
    model: config.model || buildDefaultConfig().model,
    messages: messages,
    temperature: parseFloat(config.temperature || buildDefaultConfig().temperature),
    stream: true
  };

  try {
    const response = await fetchWithRetry(config, requestBody, signal);
    const fullText = await streamResponse(response, (token) => {
      safePortPost(port, { requestId, type: "token", token });
    }, signal);

    safePortPost(port, { requestId, type: "done", text: fullText, isFullText: !!isFullText });
  } catch (err) {
    if (isStreamUnsupported(err)) {
      // Fallback to non-streaming
      delete requestBody.stream;
      const response = await fetchWithRetry(config, requestBody, signal);
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error("Ungültige API-Antwort");
      safePortPost(port, { requestId, type: "done", text: content, isFullText: !!isFullText });
    } else {
      throw err;
    }
  }
}

async function processFreePromptStreaming(port, requestId, messages, signal) {
  const config = await storageGet(DEFAULT_KEYS);

  const requestBody = {
    model: config.model || buildDefaultConfig().model,
    messages: messages,
    temperature: parseFloat(config.temperature || buildDefaultConfig().temperature),
    stream: true
  };

  try {
    const response = await fetchWithRetry(config, requestBody, signal);
    const fullText = await streamResponse(response, (token) => {
      safePortPost(port, { requestId, type: "token", token });
    }, signal);

    safePortPost(port, { requestId, type: "done", text: fullText });
  } catch (err) {
    if (isStreamUnsupported(err)) {
      delete requestBody.stream;
      const response = await fetchWithRetry(config, requestBody, signal);
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error("Ungültige API-Antwort");
      safePortPost(port, { requestId, type: "done", text: content });
    } else {
      throw err;
    }
  }
}

function isStreamUnsupported(err) {
  // Some endpoints don't support streaming and may return 400 or HTML error pages
  return err && /stream/i.test(err.message || "");
}

function safePortPost(port, message) {
  try {
    port.postMessage(message);
  } catch (e) {
    // Port disconnected — ignore
  }
}

// Parse an OpenAI-style SSE stream. Returns the concatenated text.
async function streamResponse(response, onToken, signal) {
  if (!response.body || !response.body.getReader) {
    throw new Error("Streaming not supported by this endpoint");
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    // Endpoint ignored stream:true and returned plain JSON
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (content === undefined) throw new Error("Ungültige API-Antwort");
    if (content) onToken(content);
    return content;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";

  const onAbort = () => {
    try { reader.cancel(); } catch (e) { /* ignore */ }
  };
  signal.addEventListener("abort", onAbort);

  try {
    for (;;) {
      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete lines
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        line = line.replace(/\r$/, "");

        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          return fullText;
        }

        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && delta.length > 0) {
            fullText += delta;
            onToken(delta);
          }
        } catch (e) {
          // Ignore malformed keep-alive lines
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  return fullText;
}

// --- Load actions for content script ---

async function loadActionsForContent() {
  const config = await storageGet(DEFAULT_KEYS);
  const customActions = Array.isArray(config.customActions) ? config.customActions : [];
  const freePromptEnabled = config.freePromptEnabled !== undefined
    ? config.freePromptEnabled
    : buildDefaultConfig().freePromptEnabled;
  const targetLanguage = config.targetLanguage || t("defaultTargetLanguage") || "English";

  return {
    builtin: getBuiltinActions(targetLanguage).map(a => ({ id: a.id, title: a.title })),
    custom: customActions.filter(a => a.title && a.title.trim()),
    freePromptEnabled: freePromptEnabled,
    builtinShortcuts: config.builtinShortcuts && typeof config.builtinShortcuts === 'object' ? config.builtinShortcuts : {},
    freePromptShortcut: typeof config.freePromptShortcut === 'string' ? config.freePromptShortcut : ""
  };
}

// --- Fallback: inject replacement code directly if content script is unreachable ---
// Not available in Thunderbird: the "scripting" permission/API of MV3 web
// extensions is not exposed for add-ons here, and in the Thunderbird compose
// window the content script (registered via composeScripts) is always present.
// Kept as a no-op so the shared call sites in processTextNonStreaming stay
// identical to the browser builds.
function injectReplacement(tabId, replacementText, replaceFull = false) {
  console.warn("[LLM] injectReplacement fallback is not supported in Thunderbird.");
}
