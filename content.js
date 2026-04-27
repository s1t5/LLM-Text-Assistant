(function() {
  'use strict';

  let activeInputElement = null;
  let lastProcessedElement = null;
  let floatingIcon = null;
  let actionMenu = null;
  let hideTimeout = null;

  // Actions configuration
  const ACTIONS = [
    { id: "translate", title: "🌐 Übersetzen", label: "Ins Englische übersetzen" },
    { id: "expand", title: "✍️ Ausformulieren", label: "Ausformulieren" },
    { id: "summarize", title: "📋 Zusammenfassen", label: "Zusammenfassen" },
    { id: "grammar", title: "✅ Rechtschreibung & Grammatik", label: "Korrigieren" }
  ];

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "replaceText") {
      replaceSelectedText(request.text);
      sendResponse({ success: true });
    } else if (request.action === "replaceFullText") {
      replaceFullText(request.text);
      sendResponse({ success: true });
    } else if (request.action === "showError") {
      showErrorNotification(request.message);
      sendResponse({ success: true });
    }
    return true;
  });

  // Initialize: attach focus listeners to all existing editable elements
  function init() {
    attachListeners(document.body);
    
    // Watch for dynamically added elements
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            attachListeners(node);
          }
        }
      }
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function attachListeners(root) {
    const elements = root.querySelectorAll('input, textarea, [contenteditable="true"]');
    for (const el of elements) {
      if (!el.dataset.llmListenerAttached) {
        el.dataset.llmListenerAttached = "true";
        el.addEventListener('focus', onElementFocus);
      }
    }
    // Also check if root itself is editable
    if (root.matches && root.matches('input, textarea, [contenteditable="true"]')) {
      if (!root.dataset.llmListenerAttached) {
        root.dataset.llmListenerAttached = "true";
        root.addEventListener('focus', onElementFocus);
      }
    }
  }

  function onElementFocus(e) {
    activeInputElement = e.target;
    showFloatingIcon();
  }

  // Global click handler to detect clicks outside our UI
  document.addEventListener('click', (e) => {
    const target = e.target;
    
    // Check if click is on our floating icon
    if (floatingIcon && (floatingIcon === target || floatingIcon.contains(target))) {
      return;
    }
    
    // Check if click is on our action menu
    if (actionMenu && (actionMenu === target || actionMenu.contains(target))) {
      return;
    }
    
    // Check if click is on the active input element
    if (activeInputElement && (activeInputElement === target || activeInputElement.contains(target))) {
      return;
    }
    
    // Click was outside our UI and outside active input - hide everything
    hideFloatingIcon();
    activeInputElement = null;
  }, true);

  function showFloatingIcon() {
    if (!activeInputElement) return;
    
    // Don't show for hidden or very small elements
    const rect = activeInputElement.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 20) return;

    if (!floatingIcon) {
      createFloatingIcon();
    }

    // Position icon at top-right corner of the element
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;
    
    const top = rect.top + scrollY + 4;
    const left = rect.right + scrollX - 28;

    Object.assign(floatingIcon.style, {
      top: `${top}px`,
      left: `${left}px`,
      display: 'flex'
    });

    // Add scroll/resize listener to update position
    window.addEventListener('scroll', updateIconPosition, { passive: true });
    window.addEventListener('resize', updateIconPosition, { passive: true });
  }

  function updateIconPosition() {
    if (activeInputElement && floatingIcon) {
      const rect = activeInputElement.getBoundingClientRect();
      const scrollX = window.scrollX || window.pageXOffset;
      const scrollY = window.scrollY || window.pageYOffset;
      
      const top = rect.top + scrollY + 4;
      const left = rect.right + scrollX - 28;

      Object.assign(floatingIcon.style, {
        top: `${top}px`,
        left: `${left}px`
      });
    }
  }

  function hideFloatingIcon() {
    if (floatingIcon) {
      floatingIcon.style.display = 'none';
      hideActionMenu();
    }
    window.removeEventListener('scroll', updateIconPosition);
    window.removeEventListener('resize', updateIconPosition);
  }

  function createFloatingIcon() {
    floatingIcon = document.createElement('div');
    floatingIcon.id = 'llm-assistant-icon';
    
    Object.assign(floatingIcon.style, {
      position: 'absolute',
      width: '24px',
      height: '24px',
      backgroundColor: '#4a90d9',
      borderRadius: '50%',
      cursor: 'pointer',
      zIndex: '2147483646',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      transition: 'transform 0.15s ease, opacity 0.15s ease',
      fontSize: '14px',
      lineHeight: '1',
      userSelect: 'none',
      color: 'white'
    });

    // SVG robot icon
    floatingIcon.innerHTML = '🤖';
    
    floatingIcon.addEventListener('mouseenter', () => {
      floatingIcon.style.transform = 'scale(1.15)';
      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
    });
    
    floatingIcon.addEventListener('mouseleave', () => {
      floatingIcon.style.transform = 'scale(1)';
    });
    
    floatingIcon.setAttribute('tabindex', '-1');
    
    floatingIcon.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleActionMenu();
    });

    document.body.appendChild(floatingIcon);
  }

  function toggleActionMenu() {
    if (actionMenu && actionMenu.style.display !== 'none') {
      hideActionMenu();
      return;
    }
    showActionMenu();
  }

  function showActionMenu() {
    if (!floatingIcon) return;
    
    if (!actionMenu) {
      createActionMenu();
    }

    const iconRect = floatingIcon.getBoundingClientRect();
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;

    // Position menu below the icon, aligned to right edge
    const top = iconRect.bottom + scrollY + 4;
    let left = iconRect.left + scrollX - 156 + 24; // menu width (180) - icon width (24), align right

    // Prevent going off-screen left
    if (left < 4) left = 4;
    
    Object.assign(actionMenu.style, {
      top: `${top}px`,
      left: `${left}px`,
      display: 'block'
    });

    // Clear any pending hide
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
  }

  function hideActionMenu() {
    if (actionMenu) {
      actionMenu.style.display = 'none';
    }
  }

  function createActionMenu() {
    actionMenu = document.createElement('div');
    actionMenu.id = 'llm-assistant-menu';
    
    Object.assign(actionMenu.style, {
      position: 'absolute',
      width: '180px',
      backgroundColor: 'white',
      borderRadius: '8px',
      boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
      zIndex: '2147483647',
      display: 'none',
      padding: '4px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '13px',
      overflow: 'hidden'
    });

    // Menu header
    const header = document.createElement('div');
    header.textContent = 'LLM Assistent';
    Object.assign(header.style, {
      padding: '6px 10px',
      fontWeight: '600',
      color: '#333',
      borderBottom: '1px solid #eee',
      fontSize: '12px',
      textTransform: 'uppercase',
      letterSpacing: '0.5px'
    });
    actionMenu.appendChild(header);

    // Action items
    for (const action of ACTIONS) {
      const item = document.createElement('div');
      item.className = 'llm-action-item';
      item.dataset.action = action.id;
      item.textContent = action.title;
      
      Object.assign(item.style, {
        padding: '8px 10px',
        cursor: 'pointer',
        borderRadius: '4px',
        margin: '2px 0',
        transition: 'background-color 0.1s ease',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      });

      item.addEventListener('mouseenter', () => {
        item.style.backgroundColor = '#f0f4f8';
      });
      
      item.addEventListener('mouseleave', () => {
        item.style.backgroundColor = 'transparent';
      });
      
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        executeAction(action.id);
      });

      actionMenu.appendChild(item);
    }

    // Prevent menu from causing blur
    actionMenu.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    
    actionMenu.addEventListener('mouseenter', () => {
      if (hideTimeout) {
        clearTimeout(hideTimeout);
        hideTimeout = null;
      }
    });
    
    actionMenu.addEventListener('mouseleave', () => {
      hideTimeout = setTimeout(() => {
        hideFloatingIcon();
        activeInputElement = null;
      }, 300);
    });

    document.body.appendChild(actionMenu);
  }

  function executeAction(actionId) {
    if (!activeInputElement) return;

    const text = getElementFullText(activeInputElement);
    if (!text.trim()) {
      showErrorNotification('Kein Text im Eingabefeld vorhanden');
      return;
    }

    // Store element reference before hiding UI
    lastProcessedElement = activeInputElement;

    hideActionMenu();
    hideFloatingIcon();

    // Send to background script
    chrome.runtime.sendMessage({
      action: "processFullText",
      textAction: actionId,
      text: text
    }, (response) => {
      if (chrome.runtime.lastError) {
        showErrorNotification('Fehler: ' + chrome.runtime.lastError.message);
      }
    });

    // Show processing indicator
    showProcessingIndicator();
  }

  function getElementFullText(element) {
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      return element.value || '';
    } else if (element.isContentEditable) {
      return element.innerText || element.textContent || '';
    }
    return '';
  }

  function showProcessingIndicator() {
    // Change icon to show loading state
    if (floatingIcon) {
      floatingIcon.innerHTML = '⏳';
      floatingIcon.style.display = 'flex';
    }
    
    // Auto-reset after 30 seconds (fallback)
    setTimeout(() => {
      if (floatingIcon) {
        floatingIcon.innerHTML = '🤖';
      }
    }, 30000);
  }

  function hideProcessingIndicator() {
    if (floatingIcon) {
      floatingIcon.innerHTML = '🤖';
    }
  }

  function replaceFullText(newText) {
    hideProcessingIndicator();
    
    // Use lastProcessedElement if activeInputElement was cleared
    const targetElement = activeInputElement || lastProcessedElement;
    
    if (!targetElement) {
      console.warn("[LLM Content] No active element for full text replacement");
      return;
    }

    let el = targetElement;

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      // Check if element is still in DOM
      if (!document.contains(el)) {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
          el = activeEl;
        } else {
          console.error("[LLM Content] Cannot find suitable element for replacement");
          return;
        }
      }
      
      // Use native setter for better React/framework compatibility
      try {
        const descriptor = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
        if (descriptor && descriptor.set) {
          descriptor.set.call(el, newText);
        } else {
          el.value = newText;
        }
      } catch (e) {
        el.value = newText;
      }
      
      // Move cursor to end
      el.selectionStart = el.selectionEnd = newText.length;
      
      // Dispatch events to notify frameworks
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      
      // Also trigger React-specific events
      const tracker = el._valueTracker;
      if (tracker) {
        tracker.setValue(newText);
      }
      
      // Re-show icon after replacement
      activeInputElement = el;
      lastProcessedElement = null;
      showFloatingIcon();
      
    } else if (el.isContentEditable) {
      if (!document.contains(el)) {
        console.warn("[LLM Content] ContentEditable element no longer in DOM");
        return;
      }
      
      el.innerText = newText;
      
      el.dispatchEvent(new Event('input', { bubbles: true }));
      
      activeInputElement = el;
      lastProcessedElement = null;
      showFloatingIcon();
    }
  }

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

      // Move cursor after inserted text
      if (lastNode) {
        range.setStartAfter(lastNode);
        range.setEndAfter(lastNode);
      }
      selection.removeAllRanges();
      selection.addRange(range);

      // Dispatch input event
      activeElement.dispatchEvent(new Event("input", { bubbles: true }));

      return;
    }

    console.warn("Active element is not a supported input type");
  }

  function showErrorNotification(message) {
    hideProcessingIndicator();
    
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

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();