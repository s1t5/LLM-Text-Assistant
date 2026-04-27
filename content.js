(function() {
  'use strict';

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "replaceText") {
      replaceSelectedText(request.text);
      sendResponse({ success: true });
    } else if (request.action === "showError") {
      showErrorNotification(request.message);
      sendResponse({ success: true });
    }
    return true;
  });

  function replaceSelectedText(newText) {
    const activeElement = document.activeElement;

    if (!activeElement) {
      console.warn("No active element found");
      return;
    }

    // Handle standard input and textarea elements
    if (activeElement.tagName === "INPUT" || activeElement.tagName === "TEXTAREA") {
      const el = activeElement;
      const start = el.selectionStart;
      const end = el.selectionEnd;

      if (start === undefined || end === undefined || start === end) {
        console.warn("No text selected in input element");
        return;
      }

      const originalValue = el.value;
      const before = originalValue.substring(0, start);
      const after = originalValue.substring(end);

      el.value = before + newText + after;

      const newCursorPos = start + newText.length;
      el.setSelectionRange(newCursorPos, newCursorPos);

      // Dispatch input event to notify frameworks (React, Vue, etc.)
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));

      return;
    }

    // Handle contenteditable elements
    if (activeElement.isContentEditable) {
      const selection = window.getSelection();

      if (selection.rangeCount === 0) {
        console.warn("No selection in contenteditable element");
        return;
      }

      const range = selection.getRangeAt(0);

      if (range.collapsed) {
        console.warn("Selection is collapsed (no text selected)");
        return;
      }

      // Delete selected content
      range.deleteContents();

      // Insert new text
      const textNode = document.createTextNode(newText);
      range.insertNode(textNode);

      // Move cursor after inserted text
      range.setStartAfter(textNode);
      range.setEndAfter(textNode);
      selection.removeAllRanges();
      selection.addRange(range);

      // Dispatch input event
      activeElement.dispatchEvent(new Event("input", { bubbles: true }));

      return;
    }

    console.warn("Active element is not a supported input type");
  }

  function showErrorNotification(message) {
    // Remove existing notification if present
    const existing = document.getElementById("llm-assistant-error");
    if (existing) {
      existing.remove();
    }

    const notification = document.createElement("div");
    notification.id = "llm-assistant-error";
    notification.textContent = "LLM Text Assistent: " + message;

    Object.assign(notification.style, {
      position: "fixed",
      top: "20px",
      right: "20px",
      backgroundColor: "#f44336",
      color: "white",
      padding: "16px 24px",
      borderRadius: "8px",
      boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
      zIndex: "2147483647",
      fontFamily: "system-ui, -apple-system, sans-serif",
      fontSize: "14px",
      maxWidth: "400px",
      lineHeight: "1.5",
      wordWrap: "break-word"
    });

    document.body.appendChild(notification);

    // Auto-remove after 5 seconds
    setTimeout(() => {
      if (notification.parentNode) {
        notification.remove();
      }
    }, 5000);
  }
})();