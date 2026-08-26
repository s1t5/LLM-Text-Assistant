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
| `Pub/` | Build-Artefakte (ZIPs, XPI, Firefox-Manifest) |

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

Build-Artefakte liegen in `Pub/`. Version in **beiden** Manifesten synchron erhöhen.

### Chrome (Chrome Web Store)

```bash
# Aus dem Repo-Root
zip -r Pub/<version>.zip manifest.json background.js content.js options.html options.js icons _locales
```

- Upload: [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) → „Neues Element" bzw. bestehendes Paket aktualisieren → ZIP hochladen.
- Das Chrome-`manifest.json` ist das im Repo-Root (mit `background.service_worker`).

### Firefox (addons.mozilla.org, AMO)

Firefox braucht ein eigenes Manifest mit `browser_specific_settings`:

1. **`Pub/firefox-build/` aktualisieren**: geänderte Dateien aus dem Root hineinkopieren (`background.js`, `content.js`, `options.*`, `icons/`, `_locales/`).
2. **Firefox-Manifest** liegt in `Pub/firefox-build/manifest.json` und unterscheidet sich vom Chrome-Root-Manifest durch:
   - `background.scripts` zusätzlich zu `service_worker` (Fallback für ältere FF-Versionen)
   - `browser_specific_settings.gecko.id` — **muss zur AMO-Add-on-ID passen** (aktuell: `llm-translator@s1t5.dev`). Bei ID-Mismatch lehnt AMO beim Review ab.
   - `browser_specific_settings.gecko.strict_min_version` (aktuell `109.0`)
3. **ZIP bauen** (aus `Pub/firefox-build/` heraus, nicht aus dem Root!):

```bash
cd Pub/firefox-build && zip -r ../<version>-firefox.zip manifest.json background.js content.js options.html options.js icons _locales
```

4. Upload: [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) → bestehendes Add-on → neue Version hochladen.
5. **Unsignierte XPI** (nur für Developer Edition / Nightly, nicht für Release-Firefox):

```bash
cd Pub/firefox-build && zip -r ../LLM-Text-Assistent-<version>.xpi manifest.json background.js content.js options.html options.js icons _locales
```

### Checks vor dem Upload

```bash
node --check background.js && node --check content.js && node --check options.js
python3 -m json.tool manifest.json > /dev/null
python3 -m json.tool Pub/firefox-build/manifest.json > /dev/null
```

Beide Manifeste: Versionsnummer identisch halten.
