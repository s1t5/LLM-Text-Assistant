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
- **Free Prompt (Chat mode)**: Open a chat window at the input field to give iterative instructions with full context — with ready-made preset chips (Shorter / More formal / As email / Bullet list) and an optional **page context** (title, URL, surrounding paragraphs)
- **Streaming results (live typing)**: Text appears token by token as the model generates it, no waiting for the full response
- **Works everywhere**: `<input>`, `<textarea>` and `contenteditable` elements (including rich-text editors)
- **Review before replacing** (optional): Show an old→new diff and only write the result after you confirm it

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
- **Model list from the endpoint**: "Load models" queries `GET <base>/models` and offers the available models as autocomplete
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
| **Page context / max chars** | Whether the free-prompt chat gets page title, URL and surrounding paragraphs, and the character cap (`0` = off) |
| **Confirm before replacing** | Show an old→new diff and wait for confirmation before writing the result (default: off) |

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

**Editing after a replacement**: the caret is re-anchored right after the replaced text, and all streaming helper nodes (markers) are removed when the replacement completes — the field stays fully editable afterwards, including in Thunderbird's compose window (v1.5.8 fixed a caret-jumps-to-the-start bug there).

**Streaming in Thunderbird / framework editors** (v1.5.9): results are written to the field in a single pass on completion instead of rewriting the whole field per token. Previously, per-token select-all rewrites through the editor pipeline could stack partial snapshots of the text when the editor's selection state was stale (observed in Thunderbird's compose window as repeated, shrinking copies of the mail text).

**Multi-line selections** (v1.5.10): the selected text in rich-text fields is read with its line breaks intact — results keep the original line structure instead of coming back as a single line (a regression since v1.5.0 where `Range.toString()` dropped breaks at `<br>`/block boundaries).

**Teams / React editors** (v1.5.14): replacement now works in Microsoft Teams chat compose (and other React/Vue/Angular-rendered editors). The floating icon appeared (v1.5.13 iframes fix) but the text was never replaced: the editor is framework-managed without any recognizable editor-library signals, so the extension took the direct-DOM write path — and React-style frameworks reconcile their DOM from an internal model, silently reverting un-modelled writes. Two-part fix: (1) `isFrameworkManagedCE()` now recognizes framework-rendered contenteditables (framework state markers on the editable or its parent wrapper) and routes all writes through the editing pipeline (`beforeinput`/`input` events the framework accepts); (2) direct writes in `replaceFullTextInElement()` are verified by read-back — if the write is reverted (synchronously or on the framework's async render schedule) and the field still shows exactly the pre-replacement text, the replacement is retried once through the editing pipeline.

**Teams / CKEditor model writes** (v1.5.15): v1.5.14 still failed in real Teams — its compose editor (CKEditor-based) takes execCommand writes into the DOM but never into its internal model, so the write looked successful and was silently restored on the editor's next render cycle (a DOM read-back cannot see the model). The one input path every model-owning editor natively rebuilds its model from is a paste event: the replacement is now written as a synthetic paste over a DOM select-all, after a short pause for the editor's async selection observer (CKEditor converts DOM selections into model selections only debounced), with a staged verified chain — sync pipeline write first (works for Draft.js/Lexical/ProseMirror), paste over select-all as the CKEditor path, pipeline delete + paste at the caret as recovery — every step verified before the next, cancelled the moment a new action or undo starts. Verified end-to-end against a real CKEditor 5 build: the replacement lands in the editor's model with line breaks intact (`<p>…<br>…</p>`).

## 🆕 v1.6.0 — page context, diff preview, model list

**Page context for the free prompt**: The chat window can receive more than the field's own text — the page title, the URL and the paragraphs immediately around the edited field are added as clearly-labelled background information. Toggle it per session in the chat header; the options page sets the default (`Pass page context to the chat`) and a character cap (`Max page-context characters`, default 600, `0` = off). Off by default: the surrounding page text is only read when the feature is switched on. The field's own content is never duplicated into the context.

**Preset chips in the chat**: Four ready-made instructions (Shorter, More formal, As email, Bullet list) sit above the chat input. A click drops the instruction into the input field for review — it is never sent automatically.

**Review before replacing** (optional, off by default): With `Confirm result before replacing` enabled, every finished result is shown as a word-level old→new diff (removals struck through in red, additions in green) and is only written into the field after you click **Apply**. **Discard** leaves the field untouched — for a selection action it also removes the partial result the live streaming had already written. This works for selection actions, whole-field actions and the chat's "Apply".

**Model list from the endpoint**: The options page has a **Load models** button next to the model field. It derives `GET <base>/models` from the configured chat-completions URL (`…/v1/chat/completions` → `…/v1/models`) and fills the model input's autocomplete. Works with OpenAI, Ollama, LM Studio and llama.cpp. The request runs in the background (not subject to a page's CSP), but the endpoint still needs to allow the extension origin — a `CORS/DNS` error in the status line almost always means the local server needs `--allow-origins`/`OLLAMA_ORIGINS`.

## 🔒 Privacy & Security Notes

- **No data collection**: The extension collects nothing. API calls go directly from your browser to the endpoint you configured, there is no intermediate server
- **API key storage**: Your API key is stored in the browser's extension storage and only sent as `Authorization: Bearer` header to the configured endpoint
- **Permissions**: `<all_urls>` host permission is required to detect and modify text fields on any website; `contextMenus`, `storage`, `activeTab`, `scripting` are used for the menu, settings and text replacement
- **Page context**: The optional page-context feature reads the page title, URL and surrounding text locally and sends it to your configured endpoint as part of the prompt — only when the feature is enabled. It is off by default.

## 🤝 Contributing

We welcome contributions from the community!

For code changes by third parties, please coordinate with us via email at mail@s1t5.dev before making any changes.

You can also:
- Open an Issue for bug reports or feature requests
- Submit a Pull Request for improvements
- Help improve documentation

### Repository structure (trunk + platform overlays)

The `main` branch holds **all shared sources** (content.js, background.js, options, locales, icons) plus the canonical `manifest.json` — the only place the version number lives. Platform-specific files live as overlays:

```
manifest.json                    ← Chrome manifest (canonical version)
platform/firefox/manifest.json   ← Gecko settings (gecko id, min version)
platform/thunderbird/…           ← manifest, background.js (compose
                                   injection), popup.html/js (toolbar)
```

`tools/build.mjs` assembles the three store trees into `build/`, injects the version into the Firefox/Thunderbird manifests, validates everything and packages the store zips/xpi into `dist/`:

```bash
node tools/build.mjs          # build + package all three targets
node tools/build.mjs --no-zip # verification build only
node tools/build.mjs firefox  # a single target
```

## 💖 Support the Project

If you find this project useful and would like to support its continued development, you can buy me a coffee! Your support helps me dedicate more time and resources to improving the application and adding new features. While financial support is not required, it is greatly appreciated and helps ensure the project's ongoing maintenance and enhancement.

<a href="https://www.buymeacoffee.com/s1t5" target="_blank"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-s1t5-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee"></a>
<a href="https://ko-fi.com/s1t5dev" target="_blank"><img src="https://img.shields.io/badge/Ko--Fi-s1t5dev-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Ko-fi"></a>
<a href="https://github.com/sponsors/s1t5" target="_blank"><img src="https://img.shields.io/badge/GitHub%20Sponsors-s1t5-FF9A00?style=for-the-badge&logo=github-sponsors&logoColor=white" alt="GitHub Sponsors"></a>

---

📄 *License: GNU GENERAL PUBLIC LICENSE Version 3 (see LICENSE file)*