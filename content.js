(function() {
  'use strict';

  let activeInputElement = null;
  let lastProcessedElement = null;
  let floatingIcon = null;
  let actionMenu = null;
  let hideTimeout = null;

  // Dynamic actions (loaded from storage)
  let builtinActions = [
    { id: "translate", title: "🌐 Übersetzen", label: "Ins Englische übersetzen" },
    { id: "expand", title: "✍️ Ausformulieren", label: "Ausformulieren" },
    { id: "summarize", title: "📋 Zusammenfassen", label: "Zusammenfassen" },
    { id: "grammar", title: "✅ Rechtschreibung & Grammatik", label: "Korrigieren" }
  ];
  let customActions = [];
  let freePromptEnabled = true;

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
      if (namespace === 'sync' && (changes.customActions || changes.freePromptEnabled)) {
        loadActions();
      }
    });
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
    
    // Check if click is on the chat window
    const chatContainer = document.getElementById('llm-chat-overlay');
    if (chatContainer && (chatContainer === target || chatContainer.contains(target))) {
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

    // Built-in action items
    for (const action of builtinActions) {
      actionMenu.appendChild(createActionMenuItem(action.id, action.title));
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
      customHeader.textContent = 'Eigene Aktionen';
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
        actionMenu.appendChild(createActionMenuItem(actionId, `${emoji} ${action.title}`, actionId));
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
      freePromptItem.textContent = '💬 Freier Prompt';
      
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
        fontWeight: '500'
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

    document.body.appendChild(actionMenu);
  }

  function createActionMenuItem(actionId, displayTitle) {
    const item = document.createElement('div');
    item.className = 'llm-action-item';
    item.dataset.action = actionId;
    item.textContent = displayTitle;
    
    Object.assign(item.style, {
      padding: '8px 10px',
      cursor: 'pointer',
      borderRadius: '4px',
      margin: '2px 0',
      transition: 'background-color 0.1s ease',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      color: '#2c3e50'
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

  // =====================================================================
  //  FREE PROMPT CHAT WINDOW
  // =====================================================================

  let chatWindow = null;
  let chatMessages = []; // Conversation history for the current chat session
  let pendingElement = null;

  const SYSTEM_PROMPT = "Du bist ein hilfreicher Text-Assistent. Bearbeite und formuliere Text anhand der Anweisungen des Nutzers. Antworte nur mit dem verarbeiteten Text, ohne zusätzliche Erklärungen, es sei denn, der Nutzer bittet darum.";

  function buildInitialChatMessages(contextText) {
    let systemContent = SYSTEM_PROMPT;

    if (contextText && contextText.trim()) {
      systemContent += "\n\nDer Nutzer hat folgenden Text aus seinem Eingabefeld als Kontext geladen. Beziehe dich bei allen Anweisungen auf diesen Text:\n\n---\n" + contextText + "\n---";
    }

    return [
      {
        role: "system",
        content: systemContent
      }
    ];
  }

  function openFreePromptChat() {
    if (!activeInputElement) return;
    pendingElement = activeInputElement;

    hideActionMenu();
    hideFloatingIcon();

    // Remove existing chat window if any
    const existing = document.getElementById('llm-chat-overlay');
    if (existing) existing.remove();

    // Load the current text from the input element as context
    const contextText = getElementFullText(pendingElement);

    // Reset conversation — start fresh with a system prompt for text modification
    // plus the input field text as context
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
      fontSize: '15px',
      cursor: 'move'
    });
    header.innerHTML = '<span>💬 Freier Prompt</span>';

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
      addChatMessage('assistant', 'Text aus dem Eingabefeld wurde als Kontext geladen. Du kannst jetzt Anweisungen geben, z.B. "Verbessere den Text" oder "Übersetze ins Englische".', messagesArea);
    } else {
      addChatMessage('assistant', 'Beschreibe, was mit deinem Text passieren soll. Du kannst mehrere Anweisungen nacheinander senden. Klicke auf **Übernehmen**, um das Ergebnis ins Textfeld einzusetzen.', messagesArea);
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
    inputField.placeholder = 'Anweisung eingeben...';
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
    sendBtn.textContent = 'Senden';
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
    sendBtn.addEventListener('mouseenter', () => { sendBtn.style.backgroundColor = '#3a7bc8'; });
    sendBtn.addEventListener('mouseleave', () => { sendBtn.style.backgroundColor = '#4a90d9'; });
    sendBtn.addEventListener('click', () => {
      sendChatMessage(inputField, messagesArea);
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
    resetBtn.textContent = '↺ Zurücksetzen';
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
    applyBtn.textContent = '✓ Übernehmen';
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

    document.body.appendChild(chatWindow);

    // Focus input
    setTimeout(() => inputField.focus(), 100);
  }

  function resetChatSession(messagesArea) {
    const contextText = pendingElement ? getElementFullText(pendingElement) : '';
    chatMessages = buildInitialChatMessages(contextText);
    messagesArea.innerHTML = '';

    if (contextText && contextText.trim()) {
      addChatMessage('assistant', 'Chat zurückgesetzt. Text aus dem Eingabefeld wurde neu als Kontext geladen. Was möchtest du damit machen?', messagesArea);
    } else {
      addChatMessage('assistant', 'Chat zurückgesetzt. Was möchtest du mit deinem Text machen?', messagesArea);
    }
  }

  function addChatMessage(role, content, messagesArea) {
    const msgDiv = document.createElement('div');
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

    // Render simple markdown bold
    let html = content
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
    msgDiv.innerHTML = html;

    messagesArea.appendChild(msgDiv);
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  function sendChatMessage(inputField, messagesArea) {
    const userMessage = inputField.value.trim();
    if (!userMessage) return;

    // Add user message to chat
    addChatMessage('user', userMessage, messagesArea);
    chatMessages.push({ role: 'user', content: userMessage });
    inputField.value = '';
    inputField.disabled = true;

    // Show typing indicator
    const typingDiv = document.createElement('div');
    Object.assign(typingDiv.style, {
      alignSelf: 'flex-start',
      padding: '8px 12px',
      borderRadius: '10px',
      backgroundColor: '#e9ecef',
      color: '#888',
      fontSize: '13px',
      fontStyle: 'italic'
    });
    typingDiv.textContent = 'Generiere Antwort...';
    typingDiv.id = 'llm-chat-typing';
    messagesArea.appendChild(typingDiv);
    messagesArea.scrollTop = messagesArea.scrollHeight;

    // Send to background
    chrome.runtime.sendMessage({
      action: "processFreePrompt",
      messages: chatMessages
    }, (response) => {
      // Remove typing indicator
      const typing = document.getElementById('llm-chat-typing');
      if (typing) typing.remove();

      inputField.disabled = false;
      inputField.focus();

      if (chrome.runtime.lastError) {
        addChatMessage('assistant', 'Fehler: ' + chrome.runtime.lastError.message, messagesArea);
        return;
      }

      if (response && response.success && response.text) {
        const assistantMessage = response.text;
        chatMessages.push({ role: 'assistant', content: assistantMessage });
        addChatMessage('assistant', assistantMessage, messagesArea);
      } else {
        const errMsg = (response && response.error) ? response.error : 'Unbekannter Fehler';
        addChatMessage('assistant', '❌ Fehler: ' + errMsg, messagesArea);
      }
    });
  }

  function applyLastResult() {
    // Find the last assistant message in the conversation
    const lastAssistantMsg = [...chatMessages].reverse().find(m => m.role === 'assistant');
    
    if (!lastAssistantMsg) {
      showErrorNotification('Kein generierter Text zum Übernehmen vorhanden.');
      return;
    }

    const resultText = lastAssistantMsg.content;

    // Use pendingElement or activeInputElement
    const targetElement = pendingElement || activeInputElement;
    
    if (!targetElement) {
      showErrorNotification('Kein Eingabefeld gefunden.');
      return;
    }

    replaceFullTextInElement(targetElement, resultText);

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
    if (chatWindow) {
      chatWindow.remove();
      chatWindow = null;
      chatMessages = [];
    }
  }

  // =====================================================================
  //  TEXT REPLACEMENT (shared between action & free prompt)
  // =====================================================================

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
      
    } else if (el.isContentEditable) {
      if (!document.contains(el)) {
        console.warn("[LLM Content] ContentEditable element no longer in DOM");
        return;
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
    replaceFullTextInElement(el, newText);

    // Re-show icon after replacement
    activeInputElement = el;
    lastProcessedElement = null;
    showFloatingIcon();
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