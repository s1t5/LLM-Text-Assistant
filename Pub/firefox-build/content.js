(function() {
  'use strict';

  // Guard against double injection. In Thunderbird the compose content script
  // is registered via scripting.compose.registerScripts AND additionally
  // injected via executeScript into already-open compose windows — the
  // background service worker re-runs that injection on every wake, so
  // content.js would execute multiple times in the same window (duplicate
  // message listeners, every replacement applied twice).
  // The guard stores a probe closure, not a plain boolean: calling it throws
  // once the *previous* instance's extension context was invalidated (e.g.
  // after an extension update), in which case we re-initialize instead of
  // leaving the window dead.
  if (window.__llmTextAssistentLoaded) {
    try {
      window.__llmTextAssistentLoaded();
      return; // previous instance still alive — skip re-init
    } catch (e) { /* previous context invalidated — re-init below */ }
  }
  window.__llmTextAssistentLoaded = function() { chrome.runtime.getURL(''); };

  // --- i18n helper ---
  function t(key, substitutions) {
    try {
      const msg = chrome.i18n.getMessage(key, substitutions);
      return msg || key;
    } catch (e) {
      return key;
    }
  }

  let activeInputElement = null;
  let lastProcessedElement = null;
  let floatingIcon = null;
  let actionMenu = null;
  let hideTimeout = null;

  // --- UI host (Shadow DOM) ---
  // All extension UI (icon, menu, chat, toasts) lives inside a closed shadow
  // root attached to a single zero-size host element. This is essential in
  // Thunderbird, where document.body IS the mail body: anything appended to
  // it gets serialized into the sent message. The mail serializer does not
  // cross shadow boundaries (AllowCrossShadowBoundary flag is not set), so
  // shadow content can never leak into outgoing mail. It also isolates the
  // UI from host-page CSS/JS in the browser.
  let uiHost = null;
  let uiRoot = null;
  let uiSuspended = false;

  function getUiRoot() {
    if (uiSuspended) return null;
    if (uiRoot && uiHost && uiHost.isConnected) return uiRoot;
    // Drop stale hosts (e.g. left over in a reopened draft, or from a
    // previous injection of this script whose context was invalidated).
    try {
      document.querySelectorAll('#llm-assistant-ui-host').forEach((el) => el.remove());
    } catch (e) { /* ignore */ }
    uiHost = document.createElement('div');
    uiHost.id = 'llm-assistant-ui-host';
    uiRoot = uiHost.attachShadow({ mode: 'closed' });
    (document.body || document.documentElement).appendChild(uiHost);
    return uiRoot;
  }

  function appendUi(el) {
    const root = getUiRoot();
    if (!root) return false;
    root.appendChild(el);
    return true;
  }

  function getUiElementById(id) {
    if (!uiRoot) return null;
    try {
      return uiRoot.querySelector('#' + id);
    } catch (e) {
      return null;
    }
  }

  // Detach the whole UI host from the document and forget all UI element
  // references so they are rebuilt lazily on next use. Used in Thunderbird
  // right before the mail body is serialized for sending, so that not even
  // the (empty) host div remains in the outgoing message. While suspended,
  // getUiRoot() refuses to re-create the host; any user interaction in the
  // editor resumes normal operation (if the send succeeds, the window is
  // gone and the resume never happens).
  function suspendUi() {
    uiSuspended = true;
    // Cancel any in-flight request first (the icon that would cancel it is
    // about to be destroyed).
    if (currentRequestId !== null) {
      try { cancelCurrentRequest(); } catch (e) { /* ignore */ }
    }
    if (undoToastTimer) {
      clearTimeout(undoToastTimer);
      undoToastTimer = null;
    }
    undoToast = null;
    floatingIcon = null;
    actionMenu = null;
    chatWindow = null;
    chatStreamingBubble = null;
    chatStreamingText = "";
    chatSendBtn = null;
    chatInputField = null;
    if (uiHost) {
      try { uiHost.remove(); } catch (e) { /* ignore */ }
    }
    uiHost = null;
    uiRoot = null;
    // Also remove any stale hosts (e.g. a draft saved before this cleanup
    // existed, reopened with its serialized empty host div, or a host left
    // by a previous script instance after an extension update).
    try {
      document.querySelectorAll('#llm-assistant-ui-host').forEach((el) => el.remove());
    } catch (e) { /* ignore */ }
  }

  // Drag state for floating icon
  let isDraggingIcon = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;
  let dragStartX = 0;
  let dragStartY = 0;
  let hasDragged = false;
  let savedIconPosition = null; // {top, left} if user has moved the icon

  // Active request state (for cancellation via icon click)
  let currentRequestId = null;
  let streamPort = null;
  let nextLocalRequestId = Date.now() % 100000;

  // Undo state
  let lastUndoState = null; // {element, originalText, selStart, selEnd, isFullText}
  let undoToast = null;
  let undoToastTimer = null;

  // Dynamic actions (loaded from storage)
  let builtinActions = [];
  let customActions = [];
  let freePromptEnabled = true;
  let builtinShortcuts = {};
  let freePromptShortcut = "";

  // --- Shortcut helpers ---

  function serializeKeyboardEvent(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');

    let key = e.key;
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

  function findActionForShortcut(shortcutStr) {
    if (!shortcutStr) return null;

    // Built-in actions
    for (const [actionId, sc] of Object.entries(builtinShortcuts)) {
      if (sc && sc.trim() === shortcutStr) return actionId;
    }

    // Custom actions
    for (let i = 0; i < customActions.length; i++) {
      const sc = customActions[i].shortcut;
      if (sc && sc.trim() === shortcutStr) return `custom_${i}`;
    }

    // Free prompt
    if (freePromptShortcut && freePromptShortcut.trim() === shortcutStr) {
      return 'freePrompt';
    }

    return null;
  }

  function handleShortcutKeydown(e) {
    const el = document.activeElement;
    if (!isTextInput(el)) return;

    const shortcutStr = serializeKeyboardEvent(e);
    if (!shortcutStr) return;

    const actionId = findActionForShortcut(shortcutStr);
    if (!actionId) return;

    e.preventDefault();
    e.stopPropagation();

    // Set the active element so executeAction / openFreePromptChat works correctly
    activeInputElement = el;
    // A shortcut press is user interaction in the editor — resume UI if it
    // was suspended for a send that ended up being cancelled.
    uiSuspended = false;

    if (actionId === 'freePrompt') {
      openFreePromptChat();
    } else {
      executeAction(actionId);
    }
  }

  // --- Load actions from background ---

  function loadActions() {
    chrome.runtime.sendMessage({ action: "loadActions" }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn("[LLM Content] Could not load actions:", chrome.runtime.lastError.message);
        return;
      }
        if (response && response.success && response.actions) {
        if (response.actions.builtin) {
          builtinActions = response.actions.builtin;
        }
        customActions = Array.isArray(response.actions.custom) ? response.actions.custom : [];
        freePromptEnabled = response.actions.freePromptEnabled !== false;
        builtinShortcuts = response.actions.builtinShortcuts && typeof response.actions.builtinShortcuts === 'object'
          ? response.actions.builtinShortcuts
          : {};
        freePromptShortcut = typeof response.actions.freePromptShortcut === 'string'
          ? response.actions.freePromptShortcut
          : "";

        // Rebuild action menu if it exists
        if (actionMenu) {
          actionMenu.remove();
          actionMenu = null;
          createActionMenu();
        }
      }
    });
  }

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
    } else if (request.action === "suspendUi") {
      // Thunderbird: sent right before the compose body is serialized for
      // sending/saving, so no trace of the UI can end up in the message.
      suspendUi();
      sendResponse({ success: true });
    } else if (request.action === "contextMenuProcess") {
      // Context menu selection replacement, handled with streaming via port.
      handleContextMenuProcess(request.textAction, request.text, request.selectionInfo)
        .then(() => sendResponse({ success: true }))
        .catch(() => sendResponse({ success: false }));
      return true;
    }
    return true;
  });

  // Initialize: attach focus listeners to all existing editable elements
  function init() {
    loadActions();
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

    // Listen for storage changes to reload actions
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'sync' && (changes.customActions || changes.freePromptEnabled || changes.targetLanguage || changes.builtinShortcuts || changes.freePromptShortcut || changes.customActions)) {
        loadActions();
      }
    });

    // Global shortcut listener (capture phase so we win over websites)
    document.addEventListener('keydown', handleShortcutKeydown, true);
  }

  // Track which elements already have a focus listener. A WeakSet instead of
  // a data attribute: in Thunderbird the editable element IS the mail body,
  // and any attribute we set on it would be serialized into the message.
  const listenerAttachedElements = new WeakSet();

  function attachListeners(root) {
    const elements = root.querySelectorAll('input, textarea, [contenteditable="true"]');
    for (const el of elements) {
      if (isTextInput(el) && !listenerAttachedElements.has(el)) {
        listenerAttachedElements.add(el);
        el.addEventListener('focus', onElementFocus);
      }
    }
    // Also check if root itself is editable
    if (root.matches && root.matches('input, textarea, [contenteditable="true"]')) {
      if (isTextInput(root) && !listenerAttachedElements.has(root)) {
        listenerAttachedElements.add(root);
        root.addEventListener('focus', onElementFocus);
      }
    }
  }

  function isTextInput(el) {
    if (el.tagName === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    if (el.tagName === 'INPUT') {
      // Only text-like input types, exclude buttons, checkboxes, etc.
      const textTypes = ['text', 'email', 'password', 'search', 'tel', 'url'];
      return textTypes.includes((el.type || 'text').toLowerCase());
    }
    return false;
  }

  function onElementFocus(e) {
    if (!isTextInput(e.target)) return;
    // Re-enable UI after a suspend (e.g. a Thunderbird draft was saved or a
    // send was cancelled after the suspend message arrived).
    uiSuspended = false;
    activeInputElement = e.target;
    showFloatingIcon();
  }

  // Global click handler to detect clicks outside our UI
  document.addEventListener('click', (e) => {
    const target = e.target;

    // Clicks inside our shadow UI retarget to the uiHost — never treat
    // them as "outside" clicks.
    if (uiHost && (uiHost === target || uiHost.contains(target))) {
      return;
    }

    // Check if click is on our floating icon
    if (floatingIcon && (floatingIcon === target || floatingIcon.contains(target))) {
      return;
    }

    // Check if click is on our action menu
    if (actionMenu && (actionMenu === target || actionMenu.contains(target))) {
      return;
    }

    // Check if click is on the chat window
    const chatContainer = getUiElementById('llm-chat-overlay');
    if (chatContainer && (chatContainer === target || chatContainer.contains(target))) {
      return;
    }

    // Check if click is on the undo toast
    if (undoToast && (undoToast === target || undoToast.contains(target))) {
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
    if (uiSuspended) return;
    if (!activeInputElement) return;

    // Don't show for hidden or very small elements
    const rect = activeInputElement.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 20) return;

    if (!floatingIcon) {
      createFloatingIcon();
    }

    // Apply saved position if user has dragged the icon, otherwise default to top-right of element
    if (savedIconPosition) {
      Object.assign(floatingIcon.style, {
        top: `${savedIconPosition.top}px`,
        left: `${savedIconPosition.left}px`
      });
    } else {
      const scrollX = window.scrollX || window.pageXOffset;
      const scrollY = window.scrollY || window.pageYOffset;

      const top = rect.top + scrollY + 4;
      const left = rect.right + scrollX - 28;

      Object.assign(floatingIcon.style, {
        top: `${top}px`,
        left: `${left}px`
      });
    }

    floatingIcon.style.display = 'flex';

    // Add scroll/resize listener to update position (only if not manually positioned)
    window.addEventListener('scroll', updateIconPosition, { passive: true });
    window.addEventListener('resize', updateIconPosition, { passive: true });
  }

  function updateIconPosition() {
    if (activeInputElement && floatingIcon && !isDraggingIcon && !savedIconPosition) {
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
      cursor: 'grab',
      zIndex: '2147483646',
      display: 'none',
      alignItems: 'center',
      justifyContent: 'center',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      transition: 'transform 0.15s ease, opacity 0.15s ease',
      fontSize: '14px',
      lineHeight: '1',
      userSelect: 'none',
      color: 'white',
      touchAction: 'none'
    });

    // Robot emoji icon
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

      // While processing, a click cancels the request instead of dragging/menu
      if (currentRequestId !== null) {
        cancelCurrentRequest();
        return;
      }

      floatingIcon.style.cursor = 'grabbing';

      dragStartX = e.clientX;
      dragStartY = e.clientY;
      isDraggingIcon = false;
      hasDragged = false;

      const rect = floatingIcon.getBoundingClientRect();
      const scrollX = window.scrollX || window.pageXOffset;
      const scrollY = window.scrollY || window.pageYOffset;
      dragOffsetX = rect.left + scrollX - e.clientX;
      dragOffsetY = rect.top + scrollY - e.clientY;

      document.addEventListener('mousemove', onIconDrag);
      document.addEventListener('mouseup', onIconDragEnd);
    });

    // Double-click to reset icon position to default
    floatingIcon.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      savedIconPosition = null;
      updateIconPosition();
    });

    appendUi(floatingIcon);
  }

  function onIconDrag(e) {
    if (!hasDragged && Math.abs(e.clientX - dragStartX) + Math.abs(e.clientY - dragStartY) > 5) {
      hasDragged = true;
      isDraggingIcon = true;
      floatingIcon.style.transition = 'none';
    }

    if (isDraggingIcon) {
      const newLeft = e.clientX + dragOffsetX;
      const newTop = e.clientY + dragOffsetY;

      // Keep within viewport bounds
      floatingIcon.style.left = `${Math.max(4, Math.min(window.innerWidth - 28, newLeft))}px`;
      floatingIcon.style.top = `${Math.max(4, Math.min(window.innerHeight - 28, newTop))}px`;
    }
  }

  function onIconDragEnd(e) {
    floatingIcon.style.cursor = 'grab';

    if (isDraggingIcon) {
      // Keep position where dropped
      const rect = floatingIcon.getBoundingClientRect();
      const scrollX = window.scrollX || window.pageXOffset;
      const scrollY = window.scrollY || window.pageYOffset;

      floatingIcon.style.transition = 'transform 0.15s ease, opacity 0.15s ease';

      // Save the manual position
      savedIconPosition = {
        top: rect.top + scrollY,
        left: rect.left + scrollX
      };

      isDraggingIcon = false;
    } else {
      // Simple click, not a drag
      toggleActionMenu();
    }

    document.removeEventListener('mousemove', onIconDrag);
    document.removeEventListener('mouseup', onIconDragEnd);
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
    const menuWidth = 220;
    let left = iconRect.left + scrollX - menuWidth + 24; // align right

    // Prevent going off-screen left
    if (left < 4) left = 4;
    // Prevent going off-screen right
    if (left + menuWidth > window.innerWidth) {
      left = window.innerWidth - menuWidth - 4;
    }

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
    if (uiSuspended) return;
    if (actionMenu) {
      actionMenu.remove();
    }

    actionMenu = document.createElement('div');
    actionMenu.id = 'llm-assistant-menu';

    Object.assign(actionMenu.style, {
      position: 'absolute',
      minWidth: '200px',
      maxWidth: '260px',
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
    header.textContent = t('menuHeader');
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

    // Built-in action items
    for (const action of builtinActions) {
      const shortcut = builtinShortcuts[action.id] || '';
      actionMenu.appendChild(createActionMenuItem(action.id, action.title, shortcut));
    }

    // Custom action items
    if (customActions.length > 0) {
      // Separator
      const sep = document.createElement('div');
      Object.assign(sep.style, {
        height: '1px',
        backgroundColor: '#eee',
        margin: '4px 8px'
      });
      actionMenu.appendChild(sep);

      const customHeader = document.createElement('div');
      customHeader.textContent = t('menuCustomActions');
      Object.assign(customHeader.style, {
        padding: '6px 10px',
        fontWeight: '600',
        color: '#888',
        fontSize: '11px',
        textTransform: 'uppercase',
        letterSpacing: '0.4px'
      });
      actionMenu.appendChild(customHeader);

      customActions.forEach((action, index) => {
        const actionId = `custom_${index}`;
        const emoji = action.emoji || '⚡';
        const shortcut = action.shortcut || '';
        actionMenu.appendChild(createActionMenuItem(actionId, `${emoji} ${action.title}`, shortcut));
      });
    }

    // Free Prompt entry
    if (freePromptEnabled) {
      const fepSep = document.createElement('div');
      Object.assign(fepSep.style, {
        height: '1px',
        backgroundColor: '#eee',
        margin: '4px 8px'
      });
      actionMenu.appendChild(fepSep);

      const freePromptItem = document.createElement('div');
      freePromptItem.className = 'llm-action-item';
      freePromptItem.dataset.action = 'freePrompt';

      const freePromptLabel = document.createElement('span');
      freePromptLabel.textContent = t('menuFreePrompt');
      freePromptItem.appendChild(freePromptLabel);

      if (freePromptShortcut) {
        const shortcutSpan = document.createElement('span');
        shortcutSpan.textContent = freePromptShortcut;
        Object.assign(shortcutSpan.style, {
          float: 'right',
          fontSize: '11px',
          color: '#888',
          marginLeft: '12px'
        });
        freePromptItem.appendChild(shortcutSpan);
      }

      Object.assign(freePromptItem.style, {
        padding: '8px 10px',
        cursor: 'pointer',
        borderRadius: '4px',
        margin: '2px 0',
        transition: 'background-color 0.1s ease',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        color: '#2563a8',
        fontWeight: '500',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      });

      freePromptItem.addEventListener('mouseenter', () => {
        freePromptItem.style.backgroundColor = '#f0f4f8';
      });

      freePromptItem.addEventListener('mouseleave', () => {
        freePromptItem.style.backgroundColor = 'transparent';
      });

      freePromptItem.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openFreePromptChat();
      });

      actionMenu.appendChild(freePromptItem);
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

    appendUi(actionMenu);
  }

  function createActionMenuItem(actionId, displayTitle, shortcut) {
    const item = document.createElement('div');
    item.className = 'llm-action-item';
    item.dataset.action = actionId;

    const labelSpan = document.createElement('span');
    labelSpan.textContent = displayTitle;
    item.appendChild(labelSpan);

    if (shortcut) {
      const shortcutSpan = document.createElement('span');
      shortcutSpan.textContent = shortcut;
      Object.assign(shortcutSpan.style, {
        fontSize: '11px',
        color: '#888',
        marginLeft: '12px',
        flexShrink: '0'
      });
      item.appendChild(shortcutSpan);
    }

    Object.assign(item.style, {
      padding: '8px 10px',
      cursor: 'pointer',
      borderRadius: '4px',
      margin: '2px 0',
      transition: 'background-color 0.1s ease',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      color: '#2c3e50',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center'
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
      executeAction(actionId);
    });

    return item;
  }

  // =====================================================================
  //  STREAMING CORE
  // =====================================================================

  // Track selection-replacement state per element (streaming).
  // Only valid while a selection action is running; deleted on finish/error/abort
  // so a later action starts fresh from the current selection.
  const cleanedSelection = new WeakMap();

  // =====================================================================
  //  FRAMEWORK-MANAGED CONTENTEDITABLE SUPPORT (Lexical, Quill, ProseMirror,
  //  CKEditor, Draft.js, Slate, …)
  // =====================================================================
  // These editors keep an internal model and revert direct DOM mutations
  // (el.innerText = …, range.insertNode(…)) on the next reconciliation, so a
  // replacement would silently "not happen" (e.g. on Reddit). The only
  // mutation path they accept is the native editing pipeline, i.e. text
  // inserted at the DOM selection like a user would type. execCommand is
  // deprecated but remains the only API that feeds beforeinput/input events
  // into these editors with the resulting text.

  function isFrameworkManagedCE(el) {
    if (!el || !el.isContentEditable) return false;

    // 1st signal: editor libraries attach recognizable properties to the
    // contenteditable host or expose the editor state on it.
    const hostPropKeys = [
      'contentEditableOwner', // ProseMirror (old)
      'editor',              // generic
      '__lexicalEditor',     // Lexical dev builds
      'lexicalEditor',        // Lexical
      '__quill',
      'quill',
      'ckInstance',
      '__reactContentEditable',
      '__draftInstance'
    ];
    for (const key of hostPropKeys) {
      try {
        if (el[key] || (el.dataset && el.dataset[key])) return true;
      } catch (e) { /* ignore */ }
    }

    // 2nd signal: ProseMirror marks its editable node with a class.
    if (el.classList && (el.classList.contains('ProseMirror') ||
        el.classList.contains('ql-editor') ||
        el.classList.contains('ck-editor__editable') ||
        el.classList.contains('public-DraftEditor-content'))) {
      return true;
    }

    // 3rd signal: known editor classes on the editable host or its parent
    // (some editors place the class on a wrapper element).
    try {
      if (el.closest && el.closest('.ProseMirror, .ql-editor, .ck-editor__editable, .public-DraftEditor-content, [data-lexical-editor], [data-lexical-editor="true"]')) {
        return true;
      }
    } catch (e) { /* ignore */ }

    // 4th signal: Lexical stores a registration key on the editor root as
    // data-attribute in production builds.
    try {
      if (el.dataset && el.dataset.lexicalEditor !== undefined) return true;
    } catch (e) { /* ignore */ }

    // 5th signal: Lexical attaches a `__lexicalEditor` reference on the
    // contenteditable in many builds; ProseMirror uses `pmViewDesc`.
    try {
      // eslint-disable-next-line no-unused-vars
      for (const key of Object.keys(el)) {
        if (key === 'pmViewDesc' || key === '__lexicalEditor' || key === 'lexicalEditor') {
          return true;
        }
      }
    } catch (e) { /* ignore */ }

    return false;
  }

  // True when the range still lives inside el (not detached/clamped).
  function rangeIsWithin(range, el) {
    try {
      return el.contains(range.commonAncestorContainer) && !range.collapsed;
    } catch (e) {
      return false;
    }
  }

  // Framework-compatible value write for INPUT/TEXTAREA: direct `el.value =`
  // assignments are reverted by React-controlled components because they
  // bypass the native setter and React's value tracker.
  function setNativeValue(el, value) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(el, value);
      } else {
        el.value = value;
      }
    } catch (e) {
      el.value = value;
    }
    const tracker = el._valueTracker;
    if (tracker) {
      tracker.setValue(value);
    }
  }

  // Replace `range` inside the contenteditable `el` with `text` through the
  // native editing pipeline. Returns false when the editor did not apply the
  // change — the caller then falls back to direct DOM writes.
  function execInsertTextCE(el, range, text) {
    try {
      el.focus();
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      // Empty payload: just delete the selection (frameworks revert plain
      // range.deleteContents() the same way they revert text writes).
      const cmd = (text && text.length > 0) ? 'insertText' : 'delete';
      const arg = (text && text.length > 0) ? text : null;
      if (document.execCommand(cmd, false, arg)) {
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  // Insert at cursor / replace whole field via the editing pipeline. Used for
  // full-text replacement in framework editors.
  function execSetCEText(el, text) {
    // Whole field: select everything, then insert over it.
    const all = document.createRange();
    all.selectNodeContents(el);
    if (execInsertTextCE(el, all, text)) return true;

    // Some editors reject full-select inserts; try replacing only the
    // current caret line contents, else give up and let the caller know.
    return false;
  }

  function getOrCreatePort() {
    if (streamPort) {
      try {
        // Probe the port is still alive
        streamPort.postMessage({ action: "ping" });
        return streamPort;
      } catch (e) {
        streamPort = null;
      }
    }
    try {
      streamPort = chrome.runtime.connect({ name: "llmStream" });
      streamPort.onMessage.addListener(onPortMessage);
      streamPort.onDisconnect.addListener(() => {
        streamPort = null;
      });
    } catch (e) {
      streamPort = null;
    }
    return streamPort;
  }

  // Per-request listeners: requestId -> {onToken, onDone, onError, onAborted}
  const streamListeners = new Map();

  function onPortMessage(msg) {
    if (!msg || typeof msg.requestId !== "number") return;
    const listener = streamListeners.get(msg.requestId);
    if (!listener) return;

    if (msg.type === "token" && listener.onToken) {
      listener.onToken(msg.token);
    } else if (msg.type === "done") {
      streamListeners.delete(msg.requestId);
      if (listener.onDone) listener.onDone(msg.text || "");
    } else if (msg.type === "error") {
      streamListeners.delete(msg.requestId);
      if (listener.onError) listener.onError(new Error(msg.error || t('errorGeneric')));
    } else if (msg.type === "aborted") {
      streamListeners.delete(msg.requestId);
      if (listener.onAborted) listener.onAborted();
    }
  }

  // Start a streaming action request. Returns the requestId.
  function startActionStream(textAction, text, isFullText, handlers) {
    const port = getOrCreatePort();
    if (!port) return null;

    const requestId = ++nextLocalRequestId;
    streamListeners.set(requestId, handlers);
    currentRequestId = requestId;

    try {
      port.postMessage({
        action: "start",
        requestId,
        mode: "action",
        textAction,
        text,
        isFullText
      });
    } catch (e) {
      streamListeners.delete(requestId);
      currentRequestId = null;
      return null;
    }
    return requestId;
  }

  function startFreePromptStream(messages, handlers) {
    const port = getOrCreatePort();
    if (!port) return null;

    const requestId = ++nextLocalRequestId;
    streamListeners.set(requestId, handlers);
    currentRequestId = requestId;

    try {
      port.postMessage({
        action: "start",
        requestId,
        mode: "freePrompt",
        messages
      });
    } catch (e) {
      streamListeners.delete(requestId);
      currentRequestId = null;
      return null;
    }
    return requestId;
  }

  function cancelCurrentRequest() {
    const requestId = currentRequestId;
    if (requestId === null) return;
    currentRequestId = null;

    const port = getOrCreatePort();
    if (port) {
      try {
        port.postMessage({ action: "abort", requestId });
      } catch (e) { /* ignore */ }
    }
    chrome.runtime.sendMessage({ action: "abortRequest", requestId }, () => {
      // Swallow errors — abort is best-effort
      if (chrome.runtime.lastError) { /* ignore */ }
    });

    streamListeners.delete(requestId);
  }

  // =====================================================================
  //  ACTION EXECUTION (floating menu + context menu)
  // =====================================================================

  // Returns the non-collapsed selection inside el, or null when nothing
  // is selected. Shape: {mode:'range',start,end,text,posBefore}
  //                  or  {mode:'ce',range,text,posBefore}
  function getElementSelection(el) {
    if (!el) return null;

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      if (start === undefined || end === undefined || start === null || start === end) {
        return null;
      }
      return {
        mode: 'range',
        start,
        end,
        text: el.value.substring(start, end),
        posBefore: document.activeElement === el
      };
    }

    if (el.isContentEditable) {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return null;
      const range = selection.getRangeAt(0);
      if (range.collapsed || !el.contains(range.commonAncestorContainer)) return null;
      return {
        mode: 'ce',
        range: range.cloneRange(),
        text: range.toString(),
        posBefore: document.activeElement === el
      };
    }

    return null;
  }

  // Read the selected text for the context-menu flow. Prefers the element's
  // live selection state (exact for INPUT/TEXTAREA), falls back to the raw
  // string coming from the background script.
  function resolveSelectionText(el) {
    const sel = getElementSelection(el);
    if (sel && sel.text) return sel.text;
    const s = (window.getSelection() || '').toString();
    if (s) return s;
    return '';
  }

  // Line-break policy for inline selection replacement: the result is spliced
  // between the text before and after the selection, so line breaks in the
  // LLM output would break the surrounding flow (splitting the paragraph the
  // selection lives in). Any whitespace run containing a line break collapses
  // into a single space; at the very start/end of the result it vanishes
  // entirely (nothing to separate there). Whole-field replacements
  // (startFullTextReplacement, frozen mode, replaceFullText, chat "apply")
  // keep the model's structure.
  function collapseSelectionLineBreaks(text) {
    const s = String(text);
    return s
      .replace(/(?:[ \t]*[\r\n\u2028\u2029]+)+[ \t]*$/, "")
      .replace(/^(?:[ \t]*[\r\n\u2028\u2029]+)+[ \t]*/, "")
      .replace(/[ \t]*[\r\n\u2028\u2029]+[ \t]*/g, " ");
  }

  // Full-text replacement (streaming)
  function startFullTextReplacement(textAction, el, fallbackText) {
    // Clear leftover state from a previous selection run
    cleanedSelection.delete(el);

    const text = (fallbackText !== undefined && fallbackText !== null && fallbackText !== '')
      ? fallbackText
      : getElementFullText(el);

    if (!text.trim()) {
      showErrorNotification(t('errorNoText'));
      return;
    }

    hideActionMenu();

    // Capture undo state before any modification
    captureUndoState(el, text, null, null, true);

    showProcessingIndicator();

    let accumulated = "";
    let cleaned = false;

    const finish = (finalText) => {
      hideProcessingIndicator();
      currentRequestId = null;
      replaceFullTextInElement(el, finalText);
      showUndoToast();
      activeInputElement = el;
      lastProcessedElement = null;
      showFloatingIcon();
    };

    const requestId = startActionStream(textAction, text, true, {
      onToken: (token) => {
        accumulated += token;
        if (!cleaned && accumulated.trim().length > 0) {
          // Clear the original text as soon as real content arrives
          replaceFullTextInElement(el, accumulated);
          cleaned = true;
        } else if (cleaned) {
          replaceFullTextInElement(el, accumulated);
        }
      },
      onDone: (finalText) => {
        finish(finalText || accumulated);
      },
      onError: (err) => {
        hideProcessingIndicator();
        currentRequestId = null;
        // Restore original text on error
        replaceFullTextInElement(el, text);
        lastUndoState = null;
        showErrorNotification(err.message);
      },
      onAborted: () => {
        hideProcessingIndicator();
        currentRequestId = null;
        if (accumulated.trim().length > 0) {
          replaceFullTextInElement(el, accumulated);
          showUndoToast();
        } else {
          replaceFullTextInElement(el, text);
          lastUndoState = null;
        }
        showInfoNotification(t('requestCancelled'));
      }
    });

    if (requestId === null) {
      // Streaming not available — legacy fallback via sendMessage
      chrome.runtime.sendMessage({
        action: "processFullText",
        textAction: textAction,
        text: text
      }, (response) => {
        if (chrome.runtime.lastError) {
          hideProcessingIndicator();
          currentRequestId = null;
          showErrorNotification(chrome.runtime.lastError.message);
        }
      });
    }

    lastProcessedElement = el;
  }

  // Selection replacement (streaming) — handles both range-based and contenteditable
  function startSelectionReplacement(textAction, el, sel, rawTextFallback) {
    // Clear leftover state so this run starts from the current selection
    cleanedSelection.delete(el);

    const rawText = sel.text || rawTextFallback || '';
    let streamSourceText = rawText;
    let originalFullText;
    let undoSelStart = null;
    let undoSelEnd = null;

    if (sel.mode === 'range') {
      originalFullText = el.value || '';
      undoSelStart = sel.start;
      undoSelEnd = sel.end;
      streamSourceText = rawText;
    } else if (sel.mode === 'ce') {
      if (sel.range) {
        try {
          el.focus();
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(sel.range);
        } catch (e) { /* ignore */ }
      }
      // Undo needs the full element content — for contenteditable we restore
      // via the captured innerHTML (see captureUndoState/restoreUndoState),
      // but originalText is still required as a fallback. Without it undo
      // would write the literal string "undefined" over the whole field.
      originalFullText = getElementFullText(el);
      undoSelStart = null;
      undoSelEnd = null;
    } else if (sel.mode === 'ce-frozen') {
      // No live range was available: the LLM has already received the frozen
      // selection text as input, so this run is intentionally full-field. We
      // capture undo state now (full content) and write the replacement over
      // the whole element.
      try {
        el.focus();
      } catch (e) { /* ignore */ }
      originalFullText = getElementFullText(el);
      undoSelStart = null;
      undoSelEnd = null;
    } else {
      return;
    }

    let hasTextToProcess = String(streamSourceText).trim().length > 0;
    if (!hasTextToProcess && rawTextFallback && String(rawTextFallback).trim().length > 0) {
      streamSourceText = rawTextFallback;
      hasTextToProcess = true;
    }
    const text = hasTextToProcess
      ? streamSourceText
      : (originalFullText || '');

    if (!String(text).trim()) {
      showErrorNotification(t('errorNoText'));
      return;
    }

    hideActionMenu();
    captureUndoState(el, originalFullText, undoSelStart, undoSelEnd, false);
    showProcessingIndicator();

    activeInputElement = el;

    let accumulated = "";
    const isCE = sel.mode === 'ce';
    const isFrozen = sel.mode === 'ce-frozen';
    const frameworkCE = el.isContentEditable && isFrameworkManagedCE(el);

    const applyChunk = (newText, isFinal) => {
      // Selection replacement is an inline splice into surrounding text, so
      // line breaks in the result collapse to single spaces. Frozen mode
      // rewrites the whole field and keeps the model's line structure.
      if (!isFrozen) {
        newText = collapseSelectionLineBreaks(newText);
      }
      if (frameworkCE) {
        // Framework editors revert direct DOM writes, so all writes go through
        // the editing pipeline. Frozen mode can stream whole-field rewrites;
        // a live selection is replaced once at the end, because re-inserting
        // per chunk over the original range boundaries would corrupt content.
        if (isCE && !isFinal) return;
        if (isCE && sel.range && rangeIsWithin(sel.range, el) &&
            execInsertTextCE(el, sel.range, newText)) {
          return;
        }
        const allRange = document.createRange();
        allRange.selectNodeContents(el);
        if (execInsertTextCE(el, allRange, newText)) return;
        finalizeCEFrozen(el, newText);
        return;
      }
      if (isFrozen) {
        // Frozen mode: the LLM worked on the selection text, but we have no
        // live range to surgically replace into. Replace the full field content.
        finalizeCEFrozen(el, newText);
        return;
      }
      if (isCE) {
        // Once marker mode is active (a multiline chunk was seen), stay in it:
        // replaceSelectedStreamingText would insert a *second* text node and
        // overwrite the marker state, resurrecting the duplication bug.
        const st = cleanedSelection.get(el);
        const inMarkerMode = !!(st && st.ceStart);
        if (inMarkerMode || isFinal || newText.indexOf("\n") !== -1) {
          // Multiline CE (intermediate or final): rebuild line-break structure
          // from scratch so the visible state always equals *only* newText.
          // The old fragment from the previous chunk is removed first —
          // without that, every token would append another full copy.
          finalizeCEMultiline(el, sel, newText);
        } else {
          // Single-line CE chunk: cheap in-place text node update.
          replaceSelectedStreamingText(el, sel, rawText, newText);
        }
      } else {
        replaceSelectedStreamingText(el, sel, rawText, newText);
      }
    };

    const finish = (finalText) => {
      hideProcessingIndicator();
      currentRequestId = null;
      // Apply the final chunk FIRST (uses the in-place state with its valid
      // before/after boundaries), *then* close out the state. Reversing this
      // order makes the final apply re-splice with stale original indices and
      // eats characters after the selection when the result is shorter.
      applyChunk(finalText || accumulated, true);
      cleanedSelection.delete(el);
      showUndoToast();
      activeInputElement = el;
      lastProcessedElement = null;
      showFloatingIcon();
    };

    const requestId = startActionStream(textAction, streamSourceText, false, {
      onToken: (token) => {
        accumulated += token;
        applyChunk(accumulated, false);
      },
      onDone: (finalText) => {
        finish(finalText);
      },
      onError: (err) => {
        hideProcessingIndicator();
        currentRequestId = null;
        {
          const state = cleanedSelection.get(el);
          if (state) state.completed = true;
        }
        lastUndoState = null;
        showErrorNotification(err.message);
      },
      onAborted: () => {
        hideProcessingIndicator();
        currentRequestId = null;
        if (accumulated.trim().length > 0) {
          applyChunk(accumulated, true);
          cleanedSelection.delete(el);
          showUndoToast();
        } else {
          cleanedSelection.delete(el);
          lastUndoState = null;
        }
        showInfoNotification(t('requestCancelled'));
      }
    });

    if (requestId === null) {
      // Streaming not available — legacy fallback via sendMessage
      chrome.runtime.sendMessage({
        action: "processSelection",
        textAction: textAction,
        text: text
      }, (response) => {
        if (chrome.runtime.lastError) {
          hideProcessingIndicator();
          currentRequestId = null;
          cleanedSelection.delete(el);
          showErrorNotification(chrome.runtime.lastError.message);
        }
      });
    }

    lastProcessedElement = el;
  }


  // Floating icon action: use the selection when one exists, otherwise
  // process the entire field content.
  function executeAction(actionId) {
    if (!activeInputElement) return;

    const el = activeInputElement;
    const sel = getElementSelection(el);

    if (sel && sel.text && sel.text.trim()) {
      startSelectionReplacement(actionId, el, sel, sel.text);
      return;
    }

    startFullTextReplacement(actionId, el);
  }

  // Context menu action: selection when present, otherwise the full field text.
  // `selectionInfo` (captured by the background at click time) is trusted over
  // live selection reads, which the context menu may have already clamped.
  function handleContextMenuProcess(textAction, contextText, selectionInfo) {
    return new Promise((resolve, reject) => {
      // User explicitly triggered an action (toolbar popup in Thunderbird or
      // context menu in the browser) — resume UI suspended by a cancelled send.
      uiSuspended = false;
      let el = document.activeElement;
      const isUsable = (node) => node && isTextInput(node);
      if (!isUsable(el)) {
        el = activeInputElement;
      }
      if (!isUsable(el)) {
        reject(new Error("No suitable active element"));
        return;
      }

      // Prefer the frozen background positions for INPUT/TEXTAREA: the live
      // selection may already be clamped by the context menu having opened.
      // The frozen text must still match the current field content, otherwise
      // the user edited the field in between and we fall back to live data.
      if (
        selectionInfo &&
        selectionInfo.kind === "range" &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') &&
        typeof selectionInfo.selStart === "number" &&
        typeof selectionInfo.selEnd === "number" &&
        selectionInfo.selEnd > selectionInfo.selStart &&
        selectionInfo.selStart <= el.value.length &&
        el.value.substring(selectionInfo.selStart, selectionInfo.selEnd) ===
          (selectionInfo.selectionText || "")
      ) {
        const sel = {
          mode: 'range',
          start: selectionInfo.selStart,
          end: selectionInfo.selEnd,
          text: selectionInfo.selectionText || "",
          posBefore: true
        };
        startSelectionReplacement(textAction, el, sel, contextText);
        resolve();
        return;
      }

      const liveSel = getElementSelection(el);
      if (liveSel && liveSel.text && liveSel.text.trim()) {
        startSelectionReplacement(textAction, el, liveSel, contextText);
        resolve();
        return;
      }

      // Frozen DOM selection (contenteditable) without a live match: use it as
      // the source text, applied via the dom mode.
      if (selectionInfo && selectionInfo.kind === "dom" && el.isContentEditable &&
          selectionInfo.selectionText && selectionInfo.selectionText.trim()) {
        const selection = window.getSelection();
        let range = null;
        if (selection && selection.rangeCount > 0) {
          const r = selection.getRangeAt(0);
          if (!r.collapsed && el.contains(r.commonAncestorContainer)) {
            range = r.cloneRange();
          }
        }
        if (range) {
          // Live range available — replace only the selection.
          const sel = {
            mode: 'ce',
            range,
            text: selectionInfo.selectionText,
            posBefore: true
          };
          startSelectionReplacement(textAction, el, sel, contextText);
        } else {
          // Context menu destroyed the live selection. We know from the
          // background that there *was* selected text, so process only that
          // text via the LLM and then replace the full field content with
          // the single replacement result. There is no safe way to surgically
          // splice without a range, so this is the well-defined behavior.
          const sel = {
            mode: 'ce-frozen',
            range: null,
            text: selectionInfo.selectionText,
            posBefore: true
          };
          startSelectionReplacement(textAction, el, sel, contextText);
        }
        resolve();
        return;
      }

      const fullText = getElementFullText(el) || '';
      if (!fullText.trim()) {
        reject(new Error("No suitable text found"));
        return;
      }

      startFullTextReplacement(textAction, el, fullText);
      resolve();
    });
  }

  // For selection-mode streaming: replace the captured selected range with the
  // current accumulated text. `sel` is the selection descriptor captured when
  // the action started; `rawText` is the original selected string (fallback).
  function replaceSelectedStreamingText(el, sel, rawText, newText) {
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      // After the first write we track before/after ourselves, so streaming
      // chunks replace only our generated text, regardless of cursor changes.
      // `state.completed` prevents a stale entry from hijacking a *new* action.
      if (cleanedSelection.has(el)) {
        const state = cleanedSelection.get(el);
        if (state && !state.completed && state.before !== undefined) {
          setNativeValue(el, state.before + newText + state.after);
          const cursor = state.before.length + newText.length;
          el.setSelectionRange(cursor, cursor);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
        cleanedSelection.delete(el);
      }

      // First write: capture before/after from the freshly captured selection.
      const currentValue = el.value;
      let before, after;
      if (sel && sel.mode === 'range') {
        // Only splice on the frozen indices when the original selected text is
        // still present at exactly that spot. If the user (or a stale state)
        // shifted the content since capture, silently splicing would truncate
        // surrounding characters — safer to fall back to the rawText match.
        const stillThere = currentValue.substring(sel.start, sel.end) === rawText;
        if (stillThere || !rawText) {
          before = currentValue.substring(0, sel.start);
          after = currentValue.substring(sel.end);
        } else if (rawText && currentValue.includes(rawText)) {
          const idx = currentValue.indexOf(rawText);
          before = currentValue.substring(0, idx);
          after = currentValue.substring(idx + rawText.length);
        } else {
          before = currentValue;
          after = '';
        }
      } else if (rawText && currentValue.includes(rawText)) {
        const idx = currentValue.indexOf(rawText);
        before = currentValue.substring(0, idx);
        after = currentValue.substring(idx + rawText.length);
      } else {
        // Nothing identifiable selected — append at cursor/end as a safe fallback
        before = currentValue;
        after = '';
      }
        cleanedSelection.set(el, { before, after, completed: false });
      setNativeValue(el, before + newText + after);
      const cursor = before.length + newText.length;
      el.setSelectionRange(cursor, cursor);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (el.isContentEditable) {
      let state = cleanedSelection.get(el);
      if (state && state.node && el.contains(state.node)) {
        // Subsequent chunk: update the already inserted node in place.
        state.node.textContent = newText;
      } else {
        // First write: delete the captured range and insert a single text node
        // that later chunks will update. Keeps the surrounding content intact.
        const range = state && state.range ? state.range : (sel && sel.range);
        if (!range) return;
        try {
          range.deleteContents();
        } catch (e) { /* range may be detached */ }
        const node = document.createTextNode(newText);
        try {
          range.insertNode(node);
          range.setStartAfter(node);
          range.collapse(true);
        } catch (e) {
          el.appendChild(node);
        }
        // Persist only for the contenteditable node-update path. The
        // INPUT/TEXTAREA before/after path has its own completed flag so a
        // follow-up action on this element cannot inherit stale boundaries.
        cleanedSelection.set(el, { range, node, completed: false });
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // ContentEditable: replace the range with multi-line content, splitting on
  // newlines and using <br> between segments so lines stay visible in
  // rich-text composers that ignore "\n" in plain text nodes.
  // During streaming we call this repeatedly with growing text. To avoid the
  // cumulative-duplication problem we track our own output via start/end
  // markers and rebuild only that slice.
  function finalizeCEMultiline(el, sel, newText) {
    let state = cleanedSelection.get(el);

    if (!state || !state.ceStart) {
      // A previous streaming chunk may already have inserted a single text
      // node via replaceSelectedStreamingText (state.node, no markers yet).
      // Remember it so the transition below removes it instead of leaving a
      // stale duplicate of the intermediate text next to the final result.
      let staleNode = null;
      if (state && state.node && el.contains(state.node)) {
        staleNode = state.node;
      }

      const range = sel && sel.range ? sel.range : null;
      if (!range) {
        return;
      }
      // First chunk: replace the original selection with start/end markers.
      try {
        range.deleteContents();
      } catch (e) { /* range may be detached */ }
      const startMarker = document.createTextNode('');
      const endMarker = document.createTextNode('');
      try {
        range.insertNode(endMarker);
        range.insertNode(startMarker);
        range.setStartAfter(startMarker);
        range.setEndBefore(endMarker);
      } catch (e) {
        el.appendChild(startMarker);
        el.appendChild(endMarker);
      }
      // Remove the stale single-line node from the earlier streaming phase.
      if (staleNode && staleNode.parentNode) {
        try {
          staleNode.parentNode.removeChild(staleNode);
        } catch (e) { /* ignore */ }
      }
      state = { ceStart: startMarker, ceEnd: endMarker, completed: false };
      cleanedSelection.set(el, state);
    }

    // Remove everything between the markers (previous chunk's output).
    let n = state.ceStart.nextSibling;
    while (n && n !== state.ceEnd) {
      const next = n.nextSibling;
      if (n.parentNode) n.parentNode.removeChild(n);
      n = next;
    }

    // Insert current text as text nodes + <br> between the markers.
    const lines = String(newText).split("\n");
    let cursor = state.ceStart;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 0) {
        const textNode = document.createTextNode(lines[i]);
        cursor.parentNode.insertBefore(textNode, cursor.nextSibling);
        cursor = textNode;
      }
      if (i < lines.length - 1) {
        const br = document.createElement('br');
        cursor.parentNode.insertBefore(br, cursor.nextSibling);
        cursor = br;
      }
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Frozen mode: replaces the whole contenteditable, growing in place.
  // Uses marker-based replacement so repeated calls don't duplicate content.
  function finalizeCEFrozen(el, newText) {
    let state = cleanedSelection.get(el);

    if (!state || !state.ceStart) {
      // First chunk: clear the element, then put start/end markers in.
      while (el.firstChild) {
        el.removeChild(el.firstChild);
      }
      const startMarker = document.createTextNode('');
      const endMarker = document.createTextNode('');
      el.appendChild(startMarker);
      el.appendChild(endMarker);
      state = { ceStart: startMarker, ceEnd: endMarker, completed: false };
      cleanedSelection.set(el, state);
    }

    // Remove everything between the markers (previous chunk's output).
    let n = state.ceStart.nextSibling;
    while (n && n !== state.ceEnd) {
      const next = n.nextSibling;
      if (n.parentNode) n.parentNode.removeChild(n);
      n = next;
    }

    // Insert current text between the markers.
    const lines = String(newText).split("\n");
    let cursor = state.ceStart;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 0) {
        const textNode = document.createTextNode(lines[i]);
        cursor.parentNode.insertBefore(textNode, cursor.nextSibling);
        cursor = textNode;
      }
      if (i < lines.length - 1) {
        const br = document.createElement('br');
        cursor.parentNode.insertBefore(br, cursor.nextSibling);
        cursor = br;
      }
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function getElementFullText(element) {
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      return element.value || '';
    } else if (element.isContentEditable) {
      return element.innerText || element.textContent || '';
    }
    return '';
  }

  // =====================================================================
  //  FREE PROMPT CHAT WINDOW
  // =====================================================================

  let chatWindow = null;
  let chatMessages = []; // Conversation history for the current chat session
  let pendingElement = null;
  let chatStreamingBubble = null;
  let chatStreamingText = "";
  let chatSendBtn = null;
  let chatInputField = null;

  function getFreePromptSystem() {
    return t('freePromptSystem');
  }

  function buildInitialChatMessages(contextText) {
    let systemContent = getFreePromptSystem();

    if (contextText && contextText.trim()) {
      systemContent += "\n\n" + t('freePromptContextIntro') + "\n\n---\n" + contextText + "\n---";
    }

    return [
      {
        role: "system",
        content: systemContent
      }
    ];
  }

  function openFreePromptChat() {
    if (uiSuspended) return;
    if (!activeInputElement) return;
    pendingElement = activeInputElement;

    hideActionMenu();
    hideFloatingIcon();

    // Remove existing chat window if any
    const existing = getUiElementById('llm-chat-overlay');
    if (existing) existing.remove();

    // Load the current text from the input element as context
    const contextText = getElementFullText(pendingElement);

    chatMessages = buildInitialChatMessages(contextText);

    // Create overlay
    chatWindow = document.createElement('div');
    chatWindow.id = 'llm-chat-overlay';
    Object.assign(chatWindow.style, {
      position: 'fixed',
      bottom: '20px',
      right: '20px',
      width: '420px',
      maxHeight: '500px',
      backgroundColor: '#ffffff',
      borderRadius: '12px',
      boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
      zIndex: '2147483647',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '14px',
      overflow: 'hidden',
      border: '1px solid #d0d7de'
    });

    // --- Header ---
    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '12px 16px',
      backgroundColor: '#4a90d9',
      color: '#fff',
      fontWeight: '600',
      fontSize: '15px'
    });
    const headerTitle = document.createElement('span');
    headerTitle.textContent = t('chatTitle');
    header.appendChild(headerTitle);

    const closeBtn = document.createElement('span');
    closeBtn.textContent = '✕';
    Object.assign(closeBtn.style, {
      cursor: 'pointer',
      fontSize: '18px',
      padding: '0 4px',
      opacity: '0.8',
      transition: 'opacity 0.15s'
    });
    closeBtn.addEventListener('mouseenter', () => { closeBtn.style.opacity = '1'; });
    closeBtn.addEventListener('mouseleave', () => { closeBtn.style.opacity = '0.8'; });
    closeBtn.addEventListener('click', () => {
      closeChatWindow();
    });
    header.appendChild(closeBtn);

    // --- Messages area ---
    const messagesArea = document.createElement('div');
    messagesArea.id = 'llm-chat-messages';
    Object.assign(messagesArea.style, {
      flex: '1 1 auto',
      overflowY: 'auto',
      padding: '12px',
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      maxHeight: '320px',
      minHeight: '120px',
      backgroundColor: '#f8f9fa'
    });

    // Welcome message
    if (contextText && contextText.trim()) {
      addChatMessage('assistant', t('chatWelcomeWithContext'), messagesArea);
    } else {
      addChatMessage('assistant', t('chatWelcomeNoContext'), messagesArea);
    }

    // --- Input area ---
    const inputArea = document.createElement('div');
    Object.assign(inputArea.style, {
      display: 'flex',
      borderTop: '1px solid #e0e0e0',
      padding: '10px 12px',
      gap: '8px',
      backgroundColor: '#fff'
    });

    const inputField = document.createElement('input');
    inputField.type = 'text';
    inputField.placeholder = t('chatInputPlaceholder');
    chatInputField = inputField;
    Object.assign(inputField.style, {
      flex: '1',
      padding: '8px 12px',
      border: '1px solid #d0d7de',
      borderRadius: '6px',
      fontSize: '14px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      outline: 'none'
    });
    inputField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage(inputField, messagesArea);
      }
    });

    const sendBtn = document.createElement('button');
    sendBtn.textContent = t('chatSend');
    chatSendBtn = sendBtn;
    Object.assign(sendBtn.style, {
      padding: '8px 16px',
      backgroundColor: '#4a90d9',
      color: '#fff',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      fontWeight: '500',
      fontSize: '13px',
      transition: 'background-color 0.15s'
    });
    sendBtn.addEventListener('mouseenter', () => {
      if (!sendBtn.dataset.stop) sendBtn.style.backgroundColor = '#3a7bc8';
    });
    sendBtn.addEventListener('mouseleave', () => {
      if (!sendBtn.dataset.stop) sendBtn.style.backgroundColor = '#4a90d9';
    });
    sendBtn.addEventListener('click', () => {
      if (sendBtn.dataset.stop === '1') {
        cancelCurrentRequest();
      } else {
        sendChatMessage(inputField, messagesArea);
      }
    });

    inputArea.appendChild(inputField);
    inputArea.appendChild(sendBtn);

    // --- Footer with "Übernehmen" button ---
    const footer = document.createElement('div');
    Object.assign(footer.style, {
      display: 'flex',
      justifyContent: 'flex-end',
      padding: '8px 16px 12px',
      borderTop: '1px solid #eee',
      backgroundColor: '#fff',
      gap: '8px'
    });

    const resetBtn = document.createElement('button');
    resetBtn.textContent = t('chatReset');
    Object.assign(resetBtn.style, {
      padding: '7px 14px',
      backgroundColor: '#e2e8f0',
      color: '#2c3e50',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      fontWeight: '500',
      fontSize: '13px',
      transition: 'background-color 0.15s'
    });
    resetBtn.addEventListener('mouseenter', () => { resetBtn.style.backgroundColor = '#cbd5e1'; });
    resetBtn.addEventListener('mouseleave', () => { resetBtn.style.backgroundColor = '#e2e8f0'; });
    resetBtn.addEventListener('click', () => {
      resetChatSession(messagesArea);
    });

    const applyBtn = document.createElement('button');
    applyBtn.textContent = t('chatApply');
    Object.assign(applyBtn.style, {
      padding: '7px 18px',
      backgroundColor: '#2ecc71',
      color: '#fff',
      border: 'none',
      borderRadius: '6px',
      cursor: 'pointer',
      fontWeight: '600',
      fontSize: '13px',
      transition: 'background-color 0.15s'
    });
    applyBtn.addEventListener('mouseenter', () => { applyBtn.style.backgroundColor = '#27ae60'; });
    applyBtn.addEventListener('mouseleave', () => { applyBtn.style.backgroundColor = '#2ecc71'; });
    applyBtn.addEventListener('click', () => {
      applyLastResult();
    });

    footer.appendChild(resetBtn);
    footer.appendChild(applyBtn);

    // Assemble
    chatWindow.appendChild(header);
    chatWindow.appendChild(messagesArea);
    chatWindow.appendChild(inputArea);
    chatWindow.appendChild(footer);

    appendUi(chatWindow);

    // Focus input
    setTimeout(() => inputField.focus(), 100);
  }

  function resetChatSession(messagesArea) {
    const contextText = pendingElement ? getElementFullText(pendingElement) : '';
    chatMessages = buildInitialChatMessages(contextText);
    messagesArea.innerHTML = '';

    if (contextText && contextText.trim()) {
      addChatMessage('assistant', t('chatResetWithContext'), messagesArea);
    } else {
      addChatMessage('assistant', t('chatResetNoContext'), messagesArea);
    }
  }

  function addChatMessage(role, content, messagesArea) {
    const msgDiv = document.createElement('div');
    renderChatMessageContent(msgDiv, role, content);
    messagesArea.appendChild(msgDiv);
    messagesArea.scrollTop = messagesArea.scrollHeight;
    return msgDiv;
  }

  function renderChatMessageContent(msgDiv, role, content) {
    const isUser = role === 'user';

    Object.assign(msgDiv.style, {
      alignSelf: isUser ? 'flex-end' : 'flex-start',
      maxWidth: '85%',
      padding: '8px 12px',
      borderRadius: '10px',
      backgroundColor: isUser ? '#4a90d9' : '#e9ecef',
      color: isUser ? '#fff' : '#2c3e50',
      fontSize: '14px',
      lineHeight: '1.5',
      wordWrap: 'break-word',
      whiteSpace: 'pre-wrap',
      boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
    });

    // Render simple markdown bold with plain DOM APIs instead of innerHTML.
    // Avoids any interpretation of LLM-generated text as HTML (CSP/XSS-safe).
    renderMarkdownText(msgDiv, content);
  }

  // Renders "text with **bold** and line breaks" using DOM APIs only.
  function renderMarkdownText(container, text) {
    container.textContent = '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) container.appendChild(document.createElement('br'));
      const parts = lines[i].split(/\*\*(.+?)\*\*/g);
      for (let j = 0; j < parts.length; j++) {
        if (j % 2 === 1) {
          const strong = document.createElement('strong');
          strong.textContent = parts[j];
          container.appendChild(strong);
        } else if (parts[j]) {
          container.appendChild(document.createTextNode(parts[j]));
        }
      }
    }
  }

  function setSendButtonStopMode(stopMode) {
    if (!chatSendBtn) return;
    if (stopMode) {
      chatSendBtn.dataset.stop = '1';
      chatSendBtn.textContent = t('chatStop');
      chatSendBtn.style.backgroundColor = '#e74c3c';
    } else {
      delete chatSendBtn.dataset.stop;
      chatSendBtn.textContent = t('chatSend');
      chatSendBtn.style.backgroundColor = '#4a90d9';
    }
  }

  function sendChatMessage(inputField, messagesArea) {
    const userMessage = inputField.value.trim();
    if (!userMessage) return;

    // Add user message to chat
    addChatMessage('user', userMessage, messagesArea);
    chatMessages.push({ role: 'user', content: userMessage });
    inputField.value = '';
    inputField.disabled = true;
    setSendButtonStopMode(true);

    // Prepare streaming bubble
    chatStreamingText = "";
    chatStreamingBubble = document.createElement('div');
    Object.assign(chatStreamingBubble.style, {
      alignSelf: 'flex-start',
      padding: '8px 12px',
      borderRadius: '10px',
      backgroundColor: '#e9ecef',
      color: '#888',
      fontSize: '13px',
      fontStyle: 'italic'
    });
    chatStreamingBubble.textContent = t('chatGenerating');
    messagesArea.appendChild(chatStreamingBubble);
    messagesArea.scrollTop = messagesArea.scrollHeight;

    const finishStream = (finalText) => {
      setSendButtonStopMode(false);
      inputField.disabled = false;
      inputField.focus();

      const text = finalText || chatStreamingText;
      if (chatStreamingBubble) {
        renderChatMessageContent(chatStreamingBubble, 'assistant', text);
        chatStreamingBubble.style.fontStyle = 'normal';
        chatStreamingBubble.style.color = '#2c3e50';
      }
      chatMessages.push({ role: 'assistant', content: text });
      chatStreamingBubble = null;
      chatStreamingText = "";
      messagesArea.scrollTop = messagesArea.scrollHeight;
    };

    const requestId = startFreePromptStream(chatMessages, {
      onToken: (token) => {
        if (!chatStreamingBubble) return;
        chatStreamingText += token;
        chatStreamingBubble.style.fontStyle = 'normal';
        chatStreamingBubble.style.color = '#2c3e50';
        renderChatMessageContent(chatStreamingBubble, 'assistant', chatStreamingText);
        messagesArea.scrollTop = messagesArea.scrollHeight;
      },
      onDone: (finalText) => {
        currentRequestId = null;
        finishStream(finalText);
      },
      onError: (err) => {
        currentRequestId = null;
        setSendButtonStopMode(false);
        inputField.disabled = false;
        if (chatStreamingBubble) {
          renderChatMessageContent(chatStreamingBubble, 'assistant', '❌ ' + err.message);
          chatStreamingBubble.style.fontStyle = 'normal';
          chatStreamingBubble = null;
          chatStreamingText = "";
        }
      },
      onAborted: () => {
        currentRequestId = null;
        setSendButtonStopMode(false);
        inputField.disabled = false;
        inputField.focus();
        if (chatStreamingText.trim().length > 0) {
          if (chatStreamingBubble) {
            renderChatMessageContent(chatStreamingBubble, 'assistant', chatStreamingText);
            chatStreamingBubble.style.fontStyle = 'normal';
            chatStreamingBubble.style.color = '#2c3e50';
          }
          chatMessages.push({ role: 'assistant', content: chatStreamingText });
        } else if (chatStreamingBubble) {
          chatStreamingBubble.remove();
        }
        chatStreamingBubble = null;
        chatStreamingText = "";
      }
    });

    if (requestId === null) {
      // Legacy non-streaming fallback
      chrome.runtime.sendMessage({
        action: "processFreePrompt",
        messages: chatMessages
      }, (response) => {
        currentRequestId = null;
        setSendButtonStopMode(false);
        inputField.disabled = false;
        inputField.focus();

        if (chatStreamingBubble) {
          chatStreamingBubble.remove();
          chatStreamingBubble = null;
        }

        if (chrome.runtime.lastError) {
          addChatMessage('assistant', chrome.runtime.lastError.message, messagesArea);
          return;
        }

        if (response && response.success && response.text) {
          const assistantMessage = response.text;
          chatMessages.push({ role: 'assistant', content: assistantMessage });
          addChatMessage('assistant', assistantMessage, messagesArea);
        } else {
          const errMsg = (response && response.error) ? response.error : t('errorGeneric');
          addChatMessage('assistant', '❌ ' + errMsg, messagesArea);
        }
      });
    }
  }

  function applyLastResult() {
    // Find the last assistant message in the conversation
    const lastAssistantMsg = [...chatMessages].reverse().find(m => m.role === 'assistant');

    if (!lastAssistantMsg) {
      showErrorNotification(t('errorNoResult'));
      return;
    }

    const resultText = lastAssistantMsg.content;

    // Use pendingElement or activeInputElement
    const targetElement = pendingElement || activeInputElement;

    if (!targetElement) {
      showErrorNotification(t('errorNoElement'));
      return;
    }

    // Capture undo state before applying
    const originalText = getElementFullText(targetElement);
    captureUndoState(targetElement, originalText, null, null, true);

    replaceFullTextInElement(targetElement, resultText);
    showUndoToast();

    // Re-show floating icon
    activeInputElement = targetElement;
    lastProcessedElement = null;
    pendingElement = null;

    // Close chat window
    closeChatWindow();

    // Show icon again
    showFloatingIcon();
  }

  function closeChatWindow() {
    if (currentRequestId !== null) {
      cancelCurrentRequest();
    }
    if (chatWindow) {
      chatWindow.remove();
      chatWindow = null;
      chatMessages = [];
      chatStreamingBubble = null;
      chatStreamingText = "";
      chatSendBtn = null;
      chatInputField = null;
    }
  }

  // =====================================================================
  //  TEXT REPLACEMENT (shared between action & free prompt)
  // =====================================================================

  function showProcessingIndicator() {
    // Change icon to show loading state — click to cancel
    if (floatingIcon) {
      floatingIcon.innerHTML = '⏳';
      floatingIcon.style.display = 'flex';
      floatingIcon.title = t('iconTooltipProcessing');
      floatingIcon.style.cursor = 'pointer';
    }

    // Auto-reset after 60 seconds (fallback in case of a bug)
    setTimeout(() => {
      if (floatingIcon && currentRequestId === null) {
        floatingIcon.innerHTML = '🤖';
        floatingIcon.title = '';
        floatingIcon.style.cursor = 'grab';
      }
    }, 60000);
  }

  function hideProcessingIndicator() {
    if (floatingIcon) {
      floatingIcon.innerHTML = '🤖';
      floatingIcon.title = '';
      floatingIcon.style.cursor = 'grab';
    }
  }

  function replaceFullTextInElement(el, newText) {
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

      setNativeValue(el, newText);

      // Move cursor to end
      try {
        el.selectionStart = el.selectionEnd = newText.length;
      } catch (e) { /* ignore */ }

      // Dispatch events to notify frameworks
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

    } else if (el.isContentEditable) {
      if (!document.contains(el)) {
        console.warn("[LLM Content] ContentEditable element no longer in DOM");
        return;
      }

      // Framework editors (Lexical/ProseMirror/Quill/…) revert direct DOM
      // writes on the next keystroke; route through the editing pipeline.
      if (isFrameworkManagedCE(el)) {
        if (execSetCEText(el, newText)) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }
        console.warn("[LLM Content] Framework editor rejected pipeline write, falling back");
      }

      el.innerText = newText;

      el.dispatchEvent(new Event('input', { bubbles: true }));
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
    // Capture undo state for the non-streaming legacy path
    const originalText = getElementFullText(el);
    captureUndoState(el, originalText, null, null, true);
    replaceFullTextInElement(el, newText);
    showUndoToast();

    // Re-show icon after replacement
    activeInputElement = el;
    lastProcessedElement = null;
    showFloatingIcon();
  }

  function replaceSelectedText(newText) {
    // Inline selection replacement: collapse line breaks so multi-line LLM
    // output doesn't split the paragraph around the selection.
    newText = collapseSelectionLineBreaks(newText);

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
      captureUndoState(el, originalValue, start, end, false);

      const before = originalValue.substring(0, start);
      const after = originalValue.substring(end);

      setNativeValue(el, before + newText + after);

      const newCursorPos = start + newText.length;
      el.setSelectionRange(newCursorPos, newCursorPos);

      // Dispatch input event to notify frameworks (React, Vue, etc.)
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));

      showUndoToast();
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

      captureUndoState(activeElement, activeElement.innerText || '', null, null, true);

      // Framework editors revert direct DOM writes — route the replacement
      // through the editing pipeline (see isFrameworkManagedCE).
      if (isFrameworkManagedCE(activeElement)) {
        if (execInsertTextCE(activeElement, range, newText)) {
          activeElement.dispatchEvent(new Event("input", { bubbles: true }));
          showUndoToast();
          return;
        }
        console.warn("[LLM Content] Framework editor rejected pipeline write, falling back");
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

      showUndoToast();
      return;
    }

    console.warn("Active element is not a supported input type");
  }

  // =====================================================================
  //  UNDO TOAST
  // =====================================================================

  function captureUndoState(element, originalText, selStart, selEnd, isFullText) {
    lastUndoState = {
      element,
      originalText,
      // For contenteditable, plain text (innerText) cannot restore the markup
      // — capture innerHTML so undo preserves formatting.
      originalHTML: element && element.isContentEditable ? element.innerHTML : null,
      selStart,
      selEnd,
      isFullText
    };
  }

  function showUndoToast() {
    if (!lastUndoState) return;
    showToast({
      message: t('undoReplaced'),
      buttonLabel: t('undoButton'),
      backgroundColor: '#2ecc71',
      duration: 8000,
      onButton: () => {
        restoreUndoState();
      }
    });
  }

  function restoreUndoState() {
    const state = lastUndoState;
    lastUndoState = null;
    hideUndoToast();

    if (!state || !state.element) return;

    const el = document.contains(state.element) ? state.element : document.activeElement;
    if (!el) return;

    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      setNativeValue(el, state.originalText);

      if (state.selStart !== null && state.selEnd !== null) {
        try {
          el.setSelectionRange(state.selStart, state.selEnd);
        } catch (e) { /* ignore */ }
      }

      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.focus();
    } else if (el.isContentEditable) {
      // Prefer the captured innerHTML — plain text (innerText) cannot restore
      // markup. If the markup was not captured, fall back to the original
      // text; guard against undefined/null so undo can never write the
      // literal string "undefined" into the field.
      // Framework editors (Lexical etc.) revert innerHTML writes — route
      // the restore through the editing pipeline instead.
      if (isFrameworkManagedCE(el)) {
        const restoreText = String(state.originalText !== undefined && state.originalText !== null
          ? state.originalText
          : '');
        const all = document.createRange();
        all.selectNodeContents(el);
        if (execInsertTextCE(el, all, restoreText)) {
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.focus();
          cleanedSelection.delete(el);
          return;
        }
        console.warn("[LLM Content] Framework editor rejected undo write, falling back");
      }
      if (state.originalHTML !== null && state.originalHTML !== undefined) {
        el.innerHTML = state.originalHTML;
      } else {
        el.innerText = String(state.originalText !== undefined && state.originalText !== null
          ? state.originalText
          : '');
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.focus();
    }

    cleanedSelection.delete(el);
  }

  function hideUndoToast() {
    if (undoToastTimer) {
      clearTimeout(undoToastTimer);
      undoToastTimer = null;
    }
    if (undoToast) {
      undoToast.remove();
      undoToast = null;
    }
  }

  // =====================================================================
  //  NOTIFICATIONS (error / info / toast)
  // =====================================================================

  function showToast({ message, buttonLabel, backgroundColor, duration, onButton }) {
    if (uiSuspended) return;
    hideUndoToast();

    const toast = document.createElement('div');
    toast.id = 'llm-assistant-toast';

    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      backgroundColor: backgroundColor || '#323232',
      color: 'white',
      padding: '12px 16px',
      borderRadius: '8px',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      zIndex: '2147483647',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      fontSize: '14px',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      maxWidth: '420px',
      lineHeight: '1.4',
      opacity: '0',
      transform: 'translateY(8px)',
      transition: 'opacity 0.2s ease, transform 0.2s ease'
    });

    const msgSpan = document.createElement('span');
    msgSpan.textContent = message;
    toast.appendChild(msgSpan);

    if (buttonLabel && onButton) {
      const btn = document.createElement('button');
      btn.textContent = buttonLabel;
      Object.assign(btn.style, {
        backgroundColor: 'rgba(255,255,255,0.22)',
        color: '#fff',
        border: 'none',
        borderRadius: '6px',
        padding: '6px 12px',
        cursor: 'pointer',
        fontWeight: '600',
        fontSize: '13px',
        whiteSpace: 'nowrap',
        transition: 'background-color 0.15s'
      });
      btn.addEventListener('mouseenter', () => { btn.style.backgroundColor = 'rgba(255,255,255,0.35)'; });
      btn.addEventListener('mouseleave', () => { btn.style.backgroundColor = 'rgba(255,255,255,0.22)'; });
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onButton();
      });
      toast.appendChild(btn);
    }

    appendUi(toast);
    undoToast = toast;

    // Animate in
    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });

    // Hover pauses auto-hide
    let remaining = duration;
    let timerStart = Date.now();
    const startTimer = () => {
      timerStart = Date.now();
      undoToastTimer = setTimeout(() => {
        hideUndoToast();
        lastUndoState = null;
      }, remaining);
    };
    const stopTimer = () => {
      if (undoToastTimer) {
        clearTimeout(undoToastTimer);
        undoToastTimer = null;
        remaining -= (Date.now() - timerStart);
        if (remaining < 1000) remaining = 1000;
      }
    };
    toast.addEventListener('mouseenter', stopTimer);
    toast.addEventListener('mouseleave', startTimer);

    startTimer();
  }

  function showInfoNotification(message) {
    showToast({
      message: message,
      backgroundColor: '#4a90d9',
      duration: 4000
    });
  }

  function showErrorNotification(message) {
    if (uiSuspended) return;
    hideProcessingIndicator();

    // Remove existing notification if present
    const existing = getUiElementById("llm-assistant-error");
    if (existing) {
      existing.remove();
    }

    const notification = document.createElement("div");
    notification.id = "llm-assistant-error";
    notification.textContent = t('errorPrefix') + message;

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

    appendUi(notification);

    // Auto-remove after 6 seconds
    setTimeout(() => {
      if (notification.parentNode) {
        notification.remove();
      }
    }, 6000);
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
