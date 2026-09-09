# 🤖 LLM Text Assistant - Browser Extension

**A browser extension to process, translate and refine text in any input field with LLMs, directly where you type**

<div style="display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 20px;">
  <a href="https://chromewebstore.google.com/detail/llm-text-assistent/blmkelofjkniinchmipcoahggahcoelk" target="_blank"><img src="https://img.shields.io/badge/Chrome-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome"></a>
  <a href="https://addons.mozilla.org/de/firefox/addon/llm-text-assistent/" target="_blank"><img src="https://img.shields.io/badge/Firefox-FF7139?style=for-the-badge&logo=firefoxbrowser&logoColor=white" alt="Firefox"></a>
  <a href="https://addons.thunderbird.net/de/thunderbird/addon/llm-text-assistent/" target="_blank"><img src="https://img.shields.io/badge/Thunderbird-0A6ED1?style=for-the-badge&logo=thunderbird&logoColor=white" alt="Thunderbird"></a>
  <a href="https://www.buymeacoffee.com/s1t5" target="_blank"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-s1t5-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee"></a>
  <a href="https://ko-fi.com/s1t5dev" target="_blank"><img src="https://img.shields.io/badge/Ko--Fi-s1t5dev-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Ko-fi"></a>
</div>

## ✨ Key Features

### 📌 Core Features
- **Four built-in actions**: 🌐 Translate, ✍️ Expand, 📋 Summarize, ✅ Grammar & Spelling, available via context menu and a floating 🤖 icon next to any input field
- **Custom actions**: Define your own actions with emoji, title and system prompt
- **Free Prompt (Chat mode)**: Open a chat window at the input field to give iterative instructions with full context
- **Streaming results (live typing)**: Text appears token by token as the model generates it, no waiting for the full response
- **Works everywhere**: `<input>`, `<textarea>` and `contenteditable` elements (including rich-text editors)

### ⌨️ Shortcuts & UX
- **Keyboard shortcuts**: Assign shortcuts to built-in actions, custom actions and the free prompt, triggered only while a text field is focused, always wins over page shortcuts
- **Undo toast**: After every replacement a toast appears with an **Undo** button (8 seconds, hover pauses the timer)
- **Cancel requests**: Abort a running request by clicking the loading icon (⏳) or the stop button in chat, already received text is kept
- **Robust error handling**: Configurable timeout (default 60s), automatic retries on network errors and rate limits (429/5xx), clear error messages (e.g. "check your API key" on 401)

### 🔌 Provider Support
- Works with **any OpenAI-compatible Chat Completions API**:
  - **Cloud**: OpenAI, Mistral, Groq, Google Gemini (OpenAI-compat endpoint) and more
  - **Local**: Ollama, LM Studio, llama.cpp, vLLM; no API key required, data never leaves your machine
- **Flexible configuration**: API URL, API key, model, temperature, timeout
- **Customizable system prompts** for every built-in action (e.g. `{TARGET_LANGUAGE}` placeholder for translation)

### 🌍 Internationalization
- Full UI and default prompts in **English and German** (auto-selected by browser language)
- Target language for translation is freely configurable

## 🚀 Quick Start

### Prerequisites
- **Chrome** (or any Chromium browser), **Firefox** 109+ or **Thunderbird** 128+
- An OpenAI-compatible API endpoint (cloud or local)

### 🛠️ Installation

Install the extension directly from the official stores:

<div style="display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 20px;">
  <a href="https://chromewebstore.google.com/detail/llm-text-assistent/blmkelofjkniinchmipcoahggahcoelk" target="_blank"><img src="https://img.shields.io/badge/Chrome%20Web%20Store-Install-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome Web Store"></a>
  <a href="https://addons.mozilla.org/de/firefox/addon/llm-text-assistent/" target="_blank"><img src="https://img.shields.io/badge/Firefox%20Add--ons-Install-FF7139?style=for-the-badge&logo=firefoxbrowser&logoColor=white" alt="Firefox Add-ons"></a>
  <a href="https://addons.thunderbird.net/de/thunderbird/addon/llm-text-assistent/" target="_blank"><img src="https://img.shields.io/badge/Thunderbird%20Add--ons-Install-0A6ED1?style=for-the-badge&logo=thunderbird&logoColor=white" alt="Thunderbird Add-ons"></a>
</div>

- **Chrome**: [Chrome Web Store](https://chromewebstore.google.com/detail/llm-text-assistent/blmkelofjkniinchmipcoahggahcoelk)
- **Firefox**: [addons.mozilla.org](https://addons.mozilla.org/de/firefox/addon/llm-text-assistent/)
- **Thunderbird**: [addons.thunderbird.net](https://addons.thunderbird.net/de/thunderbird/addon/llm-text-assistent/)


## ⚙️ Configuration

Open the extension options (puzzle icon in the toolbar → **LLM Text Assistant** → gear icon):

| Setting | Description |
|---------|-------------|
| **API URL** | Chat Completions endpoint, e.g. `https://api.openai.com/v1/chat/completions` |
| **API Key** | Your API key (leave empty for local endpoints) |
| **Model** | e.g. `gpt-4o-mini`, `llama3.1`, `mistral` |
| **Temperature** | Creativity (0–2, default: 0.3) |
| **Timeout (seconds)** | Max wait time per attempt (default: 60). Retries twice on timeout. |
| **Target language (Translate)** | Language to translate into (e.g. English, German, French) |
| **System prompts** | Per-action instructions, e.g. `{TARGET_LANGUAGE}` placeholder for translation |
| **Shortcuts** | Assign keyboard shortcuts to any action (canonical form: `[Ctrl+][Alt+][Shift+][Meta+]<Key>`) |

### Local endpoint examples

| Provider | URL | API Key |
|----------|-----|---------|
| **Ollama** | `http://localhost:11434/v1/chat/completions` | leave empty |
| **LM Studio** | `http://localhost:1234/v1/chat/completions` | leave empty |

## 📖 Usage

1. Mark text in an input field (or just focus the field to use the floating 🤖 icon)
2. Choose an action via right-click context menu, the floating menu, or a keyboard shortcut
3. The processed text replaces the selection / field content **live** (streaming)
4. **Cancel**: click the loading icon or "⏹ Stop" in the chat window
5. **Undo**: use the button in the green toast at the bottom right

**Line breaks**: line breaks in the result are always preserved — for selections and for whole-field processing alike.

## 🔒 Privacy & Security Notes

- **No data collection**: The extension collects nothing. API calls go directly from your browser to the endpoint you configured, there is no intermediate server
- **API key storage**: Your API key is stored in the browser's extension storage and only sent as `Authorization: Bearer` header to the configured endpoint
- **Permissions**: `<all_urls>` host permission is required to detect and modify text fields on any website; `contextMenus`, `storage`, `activeTab`, `scripting` are used for the menu, settings and text replacement

## 🤝 Contributing

We welcome contributions from the community!

For code changes by third parties, please coordinate with us via email at mail@s1t5.dev before making any changes.

You can also:
- Open an Issue for bug reports or feature requests
- Submit a Pull Request for improvements
- Help improve documentation

## 💖 Support the Project

If you find this project useful and would like to support its continued development, you can buy me a coffee! Your support helps me dedicate more time and resources to improving the application and adding new features. While financial support is not required, it is greatly appreciated and helps ensure the project's ongoing maintenance and enhancement.

<a href="https://www.buymeacoffee.com/s1t5" target="_blank"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-s1t5-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee"></a>
<a href="https://ko-fi.com/s1t5dev" target="_blank"><img src="https://img.shields.io/badge/Ko--Fi-s1t5dev-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Ko-fi"></a>
<a href="https://github.com/sponsors/s1t5" target="_blank"><img src="https://img.shields.io/badge/GitHub%20Sponsors-s1t5-FF9A00?style=for-the-badge&logo=github-sponsors&logoColor=white" alt="GitHub Sponsors"></a>

---

📄 *License: GNU GENERAL PUBLIC LICENSE Version 3 (see LICENSE file)*