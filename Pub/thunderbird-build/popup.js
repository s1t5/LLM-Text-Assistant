// Compose action popup: lists all available actions and triggers them in
// the compose window's content script (content.js) via runtime messaging.

function t(key, substitutions) {
  try {
    const msg = chrome.i18n.getMessage(key, substitutions);
    return msg || key;
  } catch (e) {
    return key;
  }
}

function renderActions(actions) {
  const container = document.getElementById('actions');
  container.textContent = '';

  const builtins = (actions.builtin && Array.isArray(actions.builtin)) ? actions.builtin : [];
  const customs = (actions.custom && Array.isArray(actions.custom)) ? actions.custom : [];
  const freePromptEnabled = actions.freePromptEnabled !== false;
  const builtinShortcuts = actions.builtinShortcuts && typeof actions.builtinShortcuts === 'object'
    ? actions.builtinShortcuts : {};
  const freePromptShortcut = typeof actions.freePromptShortcut === 'string'
    ? actions.freePromptShortcut : '';

  // Built-in actions
  for (const action of builtins) {
    const btn = document.createElement('button');
    btn.className = 'action-item';
    btn.dataset.actionId = action.id;

    const emoji = document.createElement('span');
    emoji.className = 'emoji';
    emoji.textContent = action.emoji || '⚡';
    btn.appendChild(emoji);

    const label = document.createElement('span');
    label.textContent = action.title;
    btn.appendChild(label);

    const shortcut = builtinShortcuts[action.id];
    if (shortcut) {
      const sc = document.createElement('span');
      sc.className = 'shortcut';
      sc.textContent = shortcut;
      btn.appendChild(sc);
    }

    btn.addEventListener('click', () => triggerAction(action.id));
    container.appendChild(btn);
  }

  // Custom actions
  if (customs.length > 0) {
    const divider = document.createElement('div');
    divider.className = 'divider';
    container.appendChild(divider);

    for (const action of customs) {
      const btn = document.createElement('button');
      btn.className = 'action-item';
      btn.dataset.actionId = action.id;

      const emoji = document.createElement('span');
      emoji.className = 'emoji';
      emoji.textContent = action.emoji || '⚡';
      btn.appendChild(emoji);

      const label = document.createElement('span');
      label.textContent = action.title;
      btn.appendChild(label);

      const shortcut = action.shortcut || '';
      if (shortcut) {
        const sc = document.createElement('span');
        sc.className = 'shortcut';
        sc.textContent = shortcut;
        btn.appendChild(sc);
      }

      btn.addEventListener('click', () => triggerAction(action.id));
      container.appendChild(btn);
    }
  }

  // Free prompt
  if (freePromptEnabled) {
    const divider = document.createElement('div');
    divider.className = 'divider';
    container.appendChild(divider);

    const btn = document.createElement('button');
    btn.className = 'action-item';
    btn.dataset.actionId = 'freePrompt';

    const emoji = document.createElement('span');
    emoji.className = 'emoji';
    emoji.textContent = '💬';
    btn.appendChild(emoji);

    const label = document.createElement('span');
    label.textContent = t('menuFreePrompt') || 'Free prompt';
    btn.appendChild(label);

    if (freePromptShortcut) {
      const sc = document.createElement('span');
      sc.className = 'shortcut';
      sc.textContent = freePromptShortcut;
      btn.appendChild(sc);
    }

    btn.addEventListener('click', () => triggerAction('freePrompt'));
    container.appendChild(btn);
  }
}

function triggerAction(actionId) {
  // Send the chosen action to the background, which forwards it to the
  // compose tab's content script. The popup closes itself afterwards.
  chrome.runtime.sendMessage({ action: 'composePopupTrigger', textAction: actionId }, () => {
    window.close();
  });
}

function loadActions() {
  chrome.runtime.sendMessage({ action: 'loadActions' }, (response) => {
    if (chrome.runtime.lastError) {
      console.warn('[LLM Popup] Could not load actions:', chrome.runtime.lastError.message);
      return;
    }
    if (response && response.success && response.actions) {
      renderActions(response.actions);
    }
  });
}

document.addEventListener('DOMContentLoaded', loadActions);
