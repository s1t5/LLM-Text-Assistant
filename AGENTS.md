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
| `Pub/` | Quellbäume `firefox-build/`/`thunderbird-build/` mit den plattformspezifischen Manifesten — Packquellen für den Release-Workflow. Versionierte ZIPs/XPI werden **nicht mehr gebaut** (übernimmt die GitHub Action; die bis v1.5.7 vorhandenen sind historisch). |

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

### Zeilenumbruch-Verhalten (seit v1.5.7)

Zeilenumbrüche im LLM-Ergebnis werden **immer erhalten** — bei Selektion und Ganzfeld-Ersetzung gleichermaßen. Historie:

- **Regression in v1.5.5** (Framework-Editor-Support): Mehrzeilige Ergebnisse gingen bei der Selektions-Ersetzung durch ein einzelnes `execCommand('insertText')` mit eingebettetem `\n` — das fügt Umbrüche als **reinen Text** ein, der im HTML-Editor nicht als Umbruch rendert. Der alte Pfad (`finalizeCEMultiline`) setzte `<br>`-Knoten; deshalb funktionierte v1.5.3 noch (1.5.4 wurde nie veröffentlicht, Store sprang 1.5.3 → 1.5.5).
- **v1.5.6** kollabierte die Umbrüche versehentlich aktiv zu Leerzeichen (Anforderung falsch verstanden) — in v1.5.7 vollständig revertiert.
- **Fix in v1.5.7**: `execInsertTextCE` fügt mehrzeilige Ergebnisse zeilenweise ein und setzt zwischen den Zeilen einen echten Umbruch per `execCommand('insertLineBreak')` (→ `<br>`), mit Fallback auf `insertParagraph`, falls die Engine `insertLineBreak` nicht kennt. Der Editing-Pipeline-Weg bleibt (Framework-Editoren wie Lexical/ProseMirror revertieren direkte DOM-Writes).

Test: `test-insert-ce.js` (node) prüft die Kommando-Sequenz für Blink-, Gecko- und Legacy-Engine-Modelle (Multiline, Single-Line, Leerzeile, Empty-Payload).

### Caret-/Marker-Cleanup nach Ersetzung (seit v1.5.8)

**Symptom (Bug):** In Thunderbird war der ersetzte Text im Nachgang nicht mehr editierbar — der erste Tastendruck sprang mit dem Cursor an den Textanfang.

**Ursachen (zwei, beide im Direct-Write-Pfad der ContentEditable-Ersetzung):**

1. **Selection-Desync**: `finalizeCEMultiline`/`finalizeCEFrozen`/`replaceFullTextInElement` schreiben roh ins DOM (Range-Mutationen, `innerText`), setzen danach aber die Live-Selection **nie** neu. Der Gecko-HTMLEditor des Compose-Fensters besitzt eigenen Selection-/Transaktions-State wie ein Framework-Editor — beim nächsten Tastendruck re-adressiert er die verwaiste Selection und landet am Feldanfang.
2. **Marker-Knoten akkumulieren**: der Streaming-Marker-Modus (`ceStart`/`ceEnd`, leere Textknoten) wird nur aus der WeakMap gelöscht, nie aus dem DOM — pro Ersetzung bleiben 2 leere Knoten (+ Range-Split-Fragmente) im Mail-Body, die auch serialisiert versendet wurden.

**Fix (v1.5.8), zweiteilig:**

- **Thunderbird-Pipeline**: `isThunderbirdUA()` (UA-Sniff, testbar via Parameter) macht `isFrameworkManagedCE()` im TB-Compose true → alle Writes laufen über `execInsertTextCE` (Editor-Transaktionen, Selection bleibt konsistent). Firefox/Chrome ohne Framework-Signale nehmen weiterhin die Direct-Write-Pfade.
- **`finalizeCEState(el)`** (Defense in depth, wird in `finish`/`onError`/`onAborted` vor `cleanedSelection.delete` aufgerufen): entfernt Marker- **und** Range-Split-Fragmente (leere Textknoten), re-anchort die Live-Selection ans Ende des Ergebnisses (bzw. an die alte Selektionsstelle bei Leer-Ergebnis). `anchorCaretAtEnd()` deckt zusätzlich Ganzfeld (`innerText`) und Undo-Restore (`innerHTML`) ab.

Test: `test-ce-finalize.js` (node) — UA-Erkennung, Pipeline-Routing und Cleanup (Marker-/Fragment-Entfernung, Caret-Positionen für Marker-, Leer- und Single-Node-Modus, No-Op ohne State). jsdom-Endzustands-Verifikation: `~/workspace/llm-tb-caret-debug/run-harness-e2e.js` (außerhalb des Repos, Nachweis 0 leere Knoten über 3 Läufe inkl. Wiederholungsersetzung).

### Gestapelte Text-Kopien bei Ganzfeld-Ersetzung (Fix seit v1.5.9)

**Symptom (Bug):** In Thunderbird füllte sich der Mail-Body bei einer Aktion auf den gesamten Text mit wiederholten, von hinten schrumpfenden Kopien des Textes (jede Kopie endete einen Token früher; der korrekte finale Text stand am Ende).

**Ursache:** Das Ganzfeld-Streaming schrieb bei jedem Token den kompletten Text neu — pro Token Select-All + `insertText` über die Editor-Pipeline (`execSetCEText`). Wenn die interne Selection des HTMLEditor veraltet war (z. B. nach dem Fokus-Wechsel durch das Compose-Toolbar-Popup), behandelte die Engine das Insert als Einfügen am Caret statt als Ersetzen: pro Token stapelte sich ein vollständiger Snapshot. Seit v1.5.8 routet TB alle CE-Writes über diese Pipeline, deshalb trat das Muster erst danach auf ("manchmal" — nur bei Aktionen ohne Auswahl; Selektionen puffern bereits bis zum Ende).

**Fix (v1.5.9), dreiteilig:**
- **Ganzfeld-Streaming gepuffert**: `startFullTextReplacement` schreibt bei Framework-/TB-Editoren (`isFrameworkManagedCE`, inkl. UA-Check) nur EINMAL am Stream-Ende (`finish`/`onAborted`) statt pro Token. Normale CE-Felder behalten das Live-Streaming (billiges `innerText`-Schreiben ohne Editor-State).
- **`applyChunk` (Framework-Zweig) einheitlich**: auch der Frozen-Modus (Selektion ohne Range) schreibt nur noch am Ende — kein per-Token Select-All mehr über `applyChunk`.
- **`execSetCEText` gehärtet**: nach Select-All + `insertText` wird verifiziert, dass das Feld wirklich nur den neuen Text enthält. Falls die Engine eingefügt statt ersetzt hat (alter Content bleibt stehen), folgt ein Pipeline-Delete + ein Retry; scheitert auch das, Rückgabe `false` → Aufrufer fällt auf Direct-Write-Pfade zurück. Test: `test-exec-set-ce.js` (Replace-Engine ohne Korrekturschritt, Stack-Engine mit Detektion+Retry, Broken-Engine → `false`).

Wirkung: Selektions- wie Ganzfeld-Aktionen in Thunderbird landen in genau einem Editor-Write; das Stapel-Muster kann nicht mehr entstehen.

### Fehlende Zeilenumbrüche bei Selektions-Ersetzung (Fix seit v1.5.10)

**Symptom (Bug):** In Chrome wurden bei der Ersetzung einer mehrzeiligen Selektion die Zeilenumbrüche verworfen — das Ergebnis landete als eine Zeile im Feld (bereits seit v1.5.0, unabhängig vom v1.5.9-Fix).

**Ursache:** `getElementSelection` las den CE-Selektionstext per `range.toString()`. Laut DOM-Standard konkateniert das nur Textnodes — **ohne** `\n` an `<br>`- oder Blockgrenzen (anders: `Selection.toString()`). Mehrzeilige Selektionen erreichten das LLM also als eine Zeile, das Ergebnis entsprechend auch. Umstellung erfolgte in Commit `8cb1132`.

**Fix (v1.5.10):** `selection.toString()` statt `range.toString()` in `getElementSelection` (CE-Zweig).

**Merkregel:** Der **Quelltext** einer Selektion (LLM-Input) muss Zeilenumbrüche enthalten — immer `selection.toString()` (oder INPUT/TEXTAREA-Substring). `range.toString()` niemals für Quelltext verwenden; nur wo bewusst nur sichtbarer Fließtext ohne Umbrüche gebraucht wird.

### Free Prompt öffnet kein Fenster in Thunderbird (Fix seit v1.5.11)

**Symptom (Bug):** In Thunderbird öffnete der „Free prompt"-Eintrag im Compose-Toolbar-Popup kein Chat-Fenster — der bestehende Mailtext wurde stattdessen direkt ersetzt.

**Ursache:** Das Compose-Toolbar-Popup kann den Compose-Tab nicht direkt message'n (kein Tab-Kontext), daher leitet `background.js` den Klick als `composePopupTrigger` weiter — und `background.js` routet das als `{ action: "contextMenuProcess" }` an den Content-Script. Der `contextMenuProcess`-Handler in `content.js` kannte aber nur den Browser-Kontextmenü-Pfad (Selektions-Ersetzung) und schickte `textAction === "freePrompt"` ungeprüft in die **Ganzfeld-Ersetzungs-Pipeline** — deshalb Mailtext-Ersatz statt Chat. Im Browser trat der Bug nicht auf: dort kommt freePrompt ausschließlich über das Floating-Icon-Menü (direkt `openFreePromptChat()`) oder den Shortcut — der Browser-Kontextmenü bietet freePrompt nie an.

**Fix (v1.5.11), im `contextMenuProcess`-Handler:** `textAction === "freePrompt"` short-circuitet vor der Ersetzungs-Pipeline: `uiSuspended = false` (Chat darf sich nach abgebrochenem Send wieder öffnen), Ziel-Feld per `resolveFreePromptTarget()` bestimmen, dann `openFreePromptChat()` — nie `handleContextMenuProcess()`.

**`resolveFreePromptTarget(live, remembered)`** (testbar extrahierbar): während das Toolbar-Popup offen ist, liegt der Fokus außerhalb des Compose-Dokuments, `document.activeElement` ist dann `<body>` — Priority daher wie in `handleContextMenuProcess`: aktives Textfeld zuerst, dann das zuletzt fokussierte Feld (`activeInputElement`), sonst `null` (Chat verweigert das Öffnen sauber — `openFreePromptChat()` gibt ohne `activeInputElement` leise auf, es wird **nie** ersetzt).

Test: `test-free-prompt-route.js` (node) — Routing-Priority (Body/Live/Remembered/Null-Kombinationen) + Struktur-Check, dass der Guard im Handler vor der Pipeline liegt und den Chat öffnet.

### Build

XPI/ZIPs werden **nicht mehr manuell gebaut** — der Release-Workflow packt alle drei Pakete automatisch aus den Quellbäumen. Zum lokalen Testen (nicht für den Store!) die Dateien aus `Pub/thunderbird-build/` in Thunderbird über „Add-on aus Datei installieren" laden oder temporär packen.

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

## Veröffentlichen (alle drei Stores)

### Release-Prinzip

**Manuell wird nur die Version erhöht — alles andere macht die GitHub Action.**

1. Version in **allen drei** Manifesten synchron erhöhen: `manifest.json`, `Pub/firefox-build/manifest.json`, `Pub/thunderbird-build/manifest.json`.
2. Push auf `main`. Die GitHub Action (`.github/workflows/release.yml`, läuft auf dem GitHub-Spiegel `github.com/s1t5/LLM-Text-Assistant`, den Gitea per Push-Mirror synchronisiert) übernimmt:
   - Pre-Flight-Checks: `node --check` auf alle JS-Dateien, JSON-Validierung und Versionssync aller drei Manifeste, `de`/`en`-Locale-Key-Abgleich, Build-Dirs synchron zum Root
   - Paketierung aller drei Store-Pakete frisch aus den Quellbäumen (`<version>-chrome.zip` aus dem Root, `<version>-firefox.zip` aus `Pub/firefox-build/`, `<version>-thunderbird.xpi` aus `Pub/thunderbird-build/`)
   - GitHub-Release (Tag/Name = Version, kein `v`-Präfix) mit den drei Paketen als Assets, veröffentlicht (kein Draft)
3. Fix-Commits **ohne** Version-Bump überspringen den Release sauber („Tag existiert").
4. Store-Uploads (Chrome Web Store, AMO, ATN) bleiben manuell: Pakete aus dem GitHub-Release herunterladen und in die Developer-Dashboards laden.

**Keine versionierten ZIPs/XPI mehr in `Pub/` bauen** — die bis v1.5.7 vorhandenen sind historisch; das Release liefert die verlässlichen Pakete.

### Manueller Store-Upload (aus dem GitHub-Release)

Lade `<version>-chrome.zip` / `<version>-firefox.zip` / `<version>-thunderbird.xpi` aus dem jeweiligen GitHub-Release herunter:

- **Chrome**: [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → bestehendes Paket aktualisieren. Das Chrome-Manifest ist das im Repo-Root.
- **Firefox (AMO)**: [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) → bestehendes Add-on → neue Version hochladen. Firefox braucht das eigene Manifest aus `Pub/firefox-build/manifest.json` mit `browser_specific_settings.gecko.id` = `llm-text-assistent@s1t5.dev` (seit v1.5.0; ID-Mismatch lehnt AMO beim Review ab) und `data_collection_permissions.required: ["none"]`.
- **Thunderbird (ATN)**: [addons.thunderbird.net](https://addons.thunderbird.net) → Developer-Seite → neue Version hochladen (eigene Gecko-ID `llm-text-assistent-thunderbird@s1t5.dev`).

### Spiegel-Hinweis

Der Workflow läuft auf dem GitHub-Spiegel; das Release erscheint mit kurzer Verzögerung nach dem Gitea-Push (Spiegel-Sync je Commit, zusätzlich 8-h-Intervall als Fallback). **Voraussetzung**: Das hinterlegte GitHub-Token braucht die Scopes `repo` **und** `workflow` — sonst lehnt GitHub Pushes mit Workflow-Änderungen ab und der Spiegel bleibt stehen (passiert bei v1.5.6/1.5.7; im Gitea-WebUI unter Repository → Einstellungen → Mirrors im `last_error` sichtbar).
