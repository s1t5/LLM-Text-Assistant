# AGENTS.md

Dieser Ordner enthält die **LLM Text Assistent** Browser-Erweiterung (Manifest V3).

## Projektstruktur

| Datei/Ordner | Zweck |
|---|---|
| `manifest.json` | Chrome-Manifest (MV3). Firefox hat ein eigenes Manifest in `Pub/firefox-build/`. |
| `background.js` | Service Worker: Kontextmenü, API-Calls, Streaming, Retry/Abort |
| `content.js` | Text-Ersetzung, schwebendes Icon, Chat-Fenster, Undo-Toast |
| `options.html` / `options.js` | Einstellungsseite |
| `_locales/` | i18n-Dateien (siehe unten) |
| `Pub/` | Build-Artefakte (ZIPs, XPI, Firefox-/Thunderbird-Manifeste) |

## Thunderbird-Variante

Zusätzlich zur Chrome-/Firefox-Version gibt es eine **Thunderbird-Erweiterung** in `Pub/thunderbird-build/`, die im Mail-Verfassen-Fenster (Compose) läuft.

### Unterschiede zur Browser-Version

| Bereich | Browser | Thunderbird |
|---|---|---|
| **Injection** | `content_scripts` mit `matches: ["<all_urls>"]` | `browser.scripting.compose.registerScripts()` in `background.js` (MV3 ab TB 128). Alte `browser.composeScripts.register()` ist entfernt — nur für MV2. Beim Start werden auch **bereits geöffnete** Compose-Tabs via `browser.scripting.executeScript` injiziert. |
| **Einstiegspunkt** | Kontextmenü + Floating-Icon + Shortcuts | Compose-Toolbar-Button (`compose_action` mit `default_popup: popup.html`) + Floating-Icon + Shortcuts. **Kontextmenüs werden nicht unterstützt** (keine `editable`/`selection`-Kontexte in Thunderbird) — Handler in `background.js` ist ein No-Op |
| **Permissions** | `contextMenus`, `scripting`, `activeTab` | `compose`, `scripting` (+ `storage`) |
| **Gecko-ID** | `llm-text-assistent@s1t5.dev` (AMO, seit v1.5.0) | `llm-text-assistent-thunderbird@s1t5.dev` (eigene ID, da „Doppelte Add-on-ID" bei gleicher ID wie Firefox-Version) |
| **Min-Version** | FF 109 | TB 128 (MV3-only, `scripting.compose` erfordert min. 128) |

`content.js`, `options.*` und `_locales/` sind **ungeändert** aus der Firefox-Version übernommen — die Text-Ersetzung im Compose-Fenster (HTML-Body = `contenteditable`, Plaintext-Body = `textarea`, Betreff = `input`) nutzt die gleichen Pfade.

### Build

```bash
cd Pub/thunderbird-build && zip -r ../<version>-thunderbird.xpi manifest.json background.js content.js popup.html popup.js options.html options.js icons _locales
```

Installation: Thunderbird → Add-ons & Themes → Zahnrad → „Add-on aus Datei installieren" → `.xpi` wählen. Hinweis: Unsignierte XPIs akzeptiert nur die Release-Version von Thunderbird **nicht** standardmäßig — für dauerhafte Nutzung muss das Add-on über [addons.thunderbird.net](https://addons.thunderbird.net) signiert werden (oder in Daily/Beta bzw. mit `xpinstall.signatures.required=false` testen).

## Mehrsprachigkeit (i18n)

Die Extension ist vollständig internationalisiert (aktuell Deutsch + Englisch).

### Aufbau

- `_locales/de/messages.json` — Deutsche Texte
- `_locales/en/messages.json` — Englische Texte
- `manifest.json` enthält `"default_locale": "de"` und nutzt `__MSG_key__`-Platzhalter für `name` und `description`

### Regeln für Änderungen

1. **Jeder neue UI-Text** muss als Key in **beiden** `messages.json`-Dateien hinterlegt werden — niemals hardcoden.
2. In JavaScript wird der Text über `chrome.i18n.getMessage(key, subst?)` geladen (Helper: `t(key)` in `content.js`/`options.js`/`background.js`).
3. In HTML werden statische Texte über `data-i18n="key"` gesetzt (`options.js` wendet sie via `applyI18n()` an).
4. **Platzhalter** werden in `messages.json` als `$NAME$` geschrieben und brauchen einen `placeholders`-Eintrag. Aufruf: `t('key', 'Wert')`.
5. **Default-System-Prompts** sind ebenfalls locale-abhängig (`defaultPromptTranslate`, `defaultPromptExpand`, …) und werden zur Laufzeit aus den Messages gebaut — nicht hartcodiert in `DEFAULT_CONFIG`-Literalen ändern, sondern in beiden Locale-Dateien.
6. **Neue Sprache hinzufügen**: neuen Ordner `_locales/<code>/` mit vollständiger `messages.json` anlegen. Die Keys müssen exakt zu `de` und `en` passen (gleiche Menge, gleiche Platzhalter).

### Konsistenz-Check

Nach Änderungen an Locales prüfen, dass alle genutzten Keys in allen Sprachen existieren:

```bash
python3 -c "
import json
langs = {l: set(json.load(open(f'_locales/{l}/messages.json'))) for l in ['de','en']}
base = langs['de']
for l, keys in langs.items():
    diff = base ^ keys
    assert not diff, f'Inkonsistente Keys in {l}: {diff}'
print('Locales konsistent ✓')
"
```

## Tastenkürzel (Shortcuts)

Seit v1.4.0 können Aktionen Tastenkürzel zugeordnet werden.

### Datenmodell

- **`builtinShortcuts`** (Storage-Key): Objekt mit den Built-in-IDs als Key (`translate`, `expand`, `summarize`, `grammar`) und dem Shortcut-String als Wert.
- **`freePromptShortcut`** (Storage-Key): String für den Freier-Prompt-Shortcut.
- **`customActions[N].shortcut`**: String, direkt am Custom-Action-Objekt.

### Format

Kanonische Form: `[Ctrl+][Alt+][Shift+][Meta+]<Key>`

- Modifier in fester Reihenfolge: `Ctrl`, `Alt`, `Shift`, `Meta`.
- `<Key>`: Großbuchstabe (`A`–`Z`), Ziffer (`0`–`9`), `F1`–`F12`, `Enter`, `Space`, `Escape`, `Backspace`, `Delete`, `Tab`, `ArrowUp` usw.
- macOS-`Cmd` wird intern als `Meta` gespeichert.

### Verhalten

- Der `keydown`-Listener in `content.js` läuft in der **Capture-Phase** und ruft bei einem Treffer `preventDefault()` + `stopPropagation()` auf (Extension-Kürzel gewinnt immer).
- Shortcuts werden **nur ausgelöst**, wenn ein Textfeld (`INPUT`, `TEXTAREA`, `contenteditable`) fokussiert ist.
- Das schwebende Menü zeigt konfigurierte Kürzel rechtsbündig neben dem Aktionsnamen an.

## Veröffentlichen (Chrome & Firefox)

Build-Artefakte liegen in `Pub/`. Benennungsschema: **`<version>-<ziel>.<endung>`** — also z. B. `1.5.0-chrome.zip`, `1.5.0-firefox.zip`, `1.5.0-thunderbird.xpi`. Version in **allen drei** Manifesten synchron erhöhen.

### Chrome (Chrome Web Store)

```bash
# Aus dem Repo-Root
zip -r Pub/<version>-chrome.zip manifest.json background.js content.js options.html options.js icons _locales
```

- Upload: [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) → „Neues Element" bzw. bestehendes Paket aktualisieren → ZIP hochladen.
- Das Chrome-`manifest.json` ist das im Repo-Root (mit `background.service_worker`).

### Firefox (addons.mozilla.org, AMO)

Firefox braucht ein eigenes Manifest mit `browser_specific_settings`:

1. **`Pub/firefox-build/` aktualisieren**: geänderte Dateien aus dem Root hineinkopieren (`background.js`, `content.js`, `options.*`, `icons/`, `_locales/`).
2. **Firefox-Manifest** liegt in `Pub/firefox-build/manifest.json` und unterscheidet sich vom Chrome-Root-Manifest durch:
   - `background.scripts` zusätzlich zu `service_worker` (Fallback für ältere FF-Versionen)
   - `browser_specific_settings.gecko.id` — **muss zur AMO-Add-on-ID passen**. Seit v1.5.0 lautet sie `llm-text-assistent@s1t5.dev` (früher: `llm-translator@s1t5.dev`; die alte ID wurde mit der Thunderbird-Veröffentlichung auf ATN belegt). Bei ID-Mismatch lehnt AMO beim Review ab.
   - `browser_specific_settings.gecko.strict_min_version` (aktuell `109.0`)
   - `browser_specific_settings.gecko.data_collection_permissions.required: ["none"]` — AMO-Pflicht zur Datenerklärung (hier: keine Datenerhebung, API-Calls gehen direkt an den vom Nutzer konfigurierten Endpunkt).
3. **ZIP bauen** (aus `Pub/firefox-build/` heraus, nicht aus dem Root!):

```bash
cd Pub/firefox-build && zip -r ../<version>-firefox.zip manifest.json background.js content.js options.html options.js icons _locales
```

4. Upload: [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) → bestehendes Add-on → neue Version hochladen.

### Checks vor dem Upload

```bash
node --check background.js && node --check content.js && node --check options.js
python3 -m json.tool manifest.json > /dev/null
python3 -m json.tool Pub/firefox-build/manifest.json > /dev/null
```

Beide Manifeste: Versionsnummer identisch halten.
