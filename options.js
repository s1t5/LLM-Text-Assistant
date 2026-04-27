(function() {
  'use strict';

  const DEFAULTS = {
    apiUrl: "https://api.openai.com/v1/chat/completions",
    apiKey: "",
    model: "gpt-3.5-turbo",
    temperature: "0.3",
    promptTranslate: "Übersetze den folgenden Text ins Englische. Antworte nur mit der Übersetzung, ohne zusätzliche Erklärungen:",
    promptExpand: "Formuliere die folgenden Stichpunkte oder Satzfragmente zu einem vollständigen, flüssigen Text aus. Antworte nur mit dem ausformulierten Text:",
    promptSummarize: "Fasse den folgenden Text kurz und prägnant zusammen. Antworte nur mit der Zusammenfassung:",
    promptGrammar: "Korrigiere Rechtschreibung, Grammatik und Zeichensetzung im folgenden Text. Antworte nur mit dem korrigierten Text:"
  };

  const FIELDS = [
    "apiUrl",
    "apiKey",
    "model",
    "temperature",
    "promptTranslate",
    "promptExpand",
    "promptSummarize",
    "promptGrammar"
  ];

  document.addEventListener("DOMContentLoaded", () => {
    restoreOptions();

    document.getElementById("saveBtn").addEventListener("click", saveOptions);
    document.getElementById("resetBtn").addEventListener("click", resetOptions);
  });

  function restoreOptions() {
    chrome.storage.sync.get(FIELDS, (result) => {
      for (const key of FIELDS) {
        const el = document.getElementById(key);
        if (el) {
          el.value = result[key] !== undefined ? result[key] : DEFAULTS[key];
        }
      }
    });
  }

  function saveOptions() {
    const values = {};
    for (const key of FIELDS) {
      const el = document.getElementById(key);
      values[key] = el ? el.value.trim() : "";
    }

    chrome.storage.sync.set(values, () => {
      if (chrome.runtime.lastError) {
        showStatus("Fehler beim Speichern: " + chrome.runtime.lastError.message, "error");
        return;
      }
      showStatus("Einstellungen gespeichert!", "success");
    });
  }

  function resetOptions() {
    if (!confirm("Möchtest du wirklich alle Einstellungen auf die Standardwerte zurücksetzen?")) {
      return;
    }

    chrome.storage.sync.clear(() => {
      if (chrome.runtime.lastError) {
        showStatus("Fehler beim Zurücksetzen: " + chrome.runtime.lastError.message, "error");
        return;
      }
      restoreOptions();
      showStatus("Standardwerte wiederhergestellt.", "success");
    });
  }

  function showStatus(message, type) {
    const statusEl = document.getElementById("status");
    statusEl.textContent = message;
    statusEl.className = type;

    setTimeout(() => {
      statusEl.textContent = "";
      statusEl.className = "";
    }, 3000);
  }
})();