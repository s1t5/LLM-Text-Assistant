# AGENTS.md

Dieser Ordner enthält die **LLM Text Assistent** Browser-Erweiterung (Manifest V3).
Repo: `git.schrrs.de/s1t5/LLM-Text-Assistant` (Push-Mirror auf `github.com/s1t5/LLM-Text-Assistant`).

## Projektstruktur (Trunk + Plattform-Overlays, seit v1.5.12)

| Datei/Ordner | Zweck |
|---|---|
| `manifest.json` | Chrome-Manifest (MV3) **und einzige Quelle der Versionsnummer** |
| `background.js` | Service Worker: Kontextmenü, API-Calls, Streaming, Retry/Abort, Model-Liste |
| `content.js` | Text-Ersetzung, schwebendes Icon, Chat-Fenster, Diff-Vorschau, Undo-Toast |
| `options.html` / `options.js` | Einstellungsseite |
| `_locales/` | i18n-Dateien (siehe unten) |
| `platform/firefox/manifest.json` | Gecko-Overlay (Gecko-ID, `strict_min_version`) — **ohne** `version` |
| `platform/thunderbird/` | TB-Overlay: `manifest.json`, `background.js` (Compose-Injection), `popup.html`/`popup.js` |
| `tools/build.mjs` | Baut `build/{chrome,firefox,thunderbird}` aus Root-Quellen + Overlays, injiziert die Version, validiert und packt `dist/<version>-<target>.{zip,xpi}` |
| `build/`, `dist/` | generiert, gitignored — **niemals** direkt editieren oder committen |
| `test-*.js` | Node-Tests, string-slicen Funktionen aus den ausgelieferten Quellen |

> **Historie:** Bis v1.5.11 lagen die Plattform-Quellbäume in `Pub/{firefox,thunderbird}-build/`.
> Diese Struktur ist mit v1.5.12 entfallen (Trunk + Overlays). Versionierte ZIPs/XPI in `Pub/`
> gibt es nur noch bis v1.5.7 als historische Artefakte. `Pub/` nicht mehr verwenden.

### Build

```bash
node tools/build.mjs            # alle drei Targets bauen + packen
node tools/build.mjs --no-zip   # Verifikations-Build (schnell, ohne Pakete)
node tools/build.mjs firefox    # einzelnes Target
```

Der Build prüft: JS-Syntax (`node --check`), Versionsformat `x.y.z`, Locale-Key-Parität
`de`/`en`, Vollständigkeit der Overlays — und bricht bei Fehlern mit Exit-Code ≠ 0 ab.
Die Version wird **nur** im Root-`manifest.json` gepflegt und zur Build-Zeit in die
Firefox-/Thunderbird-Manifeste injiziert.

### Tests

```bash
node test-insert-ce.js         # mehrzeilige execInsertTextCE-Kommando-Sequenzen
node test-ce-finalize.js       # Marker-/Fragment-Cleanup, Caret, TB-Pipeline-Routing
node test-exec-set-ce.js       # Ganzfeld-Write-Verifikation (Replace/Stack/Broken-Engine)
node test-free-prompt-route.js # contextMenuProcess-Routing + Focus-Erkennung
node test-frame-routing.js     # all_frames + frame-sensitiver Message-Routing
node test-v16-features.js      # diffWords, modelsUrlFromApiUrl, collectPageContext
node test-shortcut-priority.js # document_start-Guard: Shortcut-Priorität, Swallow-Logik, Hook-Vertrag
node test-confirm-before-replace.js # Confirm-Gate in allen Schreibpfaden (kein Vorab-Schreiben)
```

Die Tests slicen die Funktionen per String-Slicing aus den ausgelieferten Quellen und
werten sie aus — sie testen also echten Code, keine Kopie.

## Thunderbird-Variante

Zusätzlich zur Chrome-/Firefox-Version gibt es eine **Thunderbird-Erweiterung** (`platform/thunderbird/`),
die im Mail-Verfassen-Fenster (Compose) läuft.

### Unterschiede zur Browser-Version

| Bereich | Browser | Thunderbird |
|---|---|---|
| **Injection** | `content_scripts` mit `matches: ["<all_urls>"]`, `all_frames`, `match_about_blank` | `browser.scripting.compose.registerScripts()` in `background.js` (MV3 ab TB 128). Beim Start werden auch **bereits geöffnete** Compose-Tabs via `browser.scripting.executeScript` injiziert. |
| **Einstiegspunkt** | Kontextmenü + Floating-Icon + Shortcuts | Compose-Toolbar-Button (`compose_action` mit `default_popup: popup.html`) + Floating-Icon + Shortcuts. **Kontextmenüs werden nicht unterstützt** — der Handler in `background.js` ist ein No-Op |
| **Permissions** | `contextMenus`, `scripting`, `activeTab`, `storage` | `compose`, `scripting`, `storage` |
| **Gecko-ID** | `llm-text-assistent@s1t5.dev` (AMO, seit v1.5.0) | `llm-text-assistent-thunderbird@s1t5.dev` (eigene ID, da „Doppelte Add-on-ID" bei gleicher ID wie Firefox-Version) |
| **Min-Version** | FF 109 | TB 128 (MV3-only, `scripting.compose` erfordert min. 128) |
| **`background.js`** | Root-Version (mit Kontextmenü-Verwaltung) | Overlay-Version (**divergiert**: Kontextmenü raus, Compose-Script-Injection rein) |

`content.js`, `options.*` und `_locales/` sind zwischen den Targets identisch — die
Text-Ersetzung im Compose-Fenster (HTML-Body = `contenteditable`, Plaintext-Body =
`textarea`, Betreff = `input`) nutzt die gleichen Pfade.

> **Achtung:** `platform/thunderbird/background.js` ist eine eigene Kopie der Root-Datei.
> Änderungen an geteilten Funktionen (Prompt-Aufbau, HTTP-Layer, Streaming, Model-Liste)
> müssen in **beiden** Dateien erfolgen. `DEFAULT_KEYS` und `buildDefaultConfig()` müssen
> synchron bleiben, sonst divergiert das `onInstalled`-Seeding.

## Text-Ersetzungs-Architektur

Jede Regel darüber, **wie** LLM-Ergebnisse in Felder geschrieben werden, muss **jede**
Schicht treffen, sonst divergieren Streaming-, Legacy-Message- und Background-Fallback-Pfade
still. Die Schichten: `applyChunk` (Streaming), `replaceSelectedText`/`replaceFullText`
(Legacy-Message), `injectReplacement` in `background.js` (Root; TB-Overlay ist ein No-Op).

### Zeilenumbruch-Verhalten (seit v1.5.7)

Zeilenumbrüche im LLM-Ergebnis werden **immer erhalten** — bei Selektion und Ganzfeld-Ersetzung gleichermaßen. Historie:

- **Regression in v1.5.5** (Framework-Editor-Support): Mehrzeilige Ergebnisse gingen bei der Selektions-Ersetzung durch ein einzelnes `execCommand('insertText')` mit eingebettetem `\n` — das fügt Umbrüche als **reinen Text** ein, der im HTML-Editor nicht als Umbruch rendert. Der alte Pfad (`finalizeCEMultiline`) setzte `<br>`-Knoten; deshalb funktionierte v1.5.3 noch (1.5.4 wurde nie veröffentlicht, Store sprang 1.5.3 → 1.5.5).
- **v1.5.6** kollabierte die Umbrüche versehentlich aktiv zu Leerzeichen (Anforderung falsch verstanden) — in v1.5.7 vollständig revertiert.
- **Fix in v1.5.7**: `execInsertTextCE` fügt mehrzeilige Ergebnisse zeilenweise ein und setzt zwischen den Zeilen einen echten Umbruch per `execCommand('insertLineBreak')` (→ `<br>`), mit Fallback auf `insertParagraph`, falls die Engine `insertLineBreak` nicht kennt.

Test: `test-insert-ce.js` (node) prüft die Kommando-Sequenz für Blink-, Gecko- und Legacy-Engine-Modelle (Multiline, Single-Line, Leerzeile, Empty-Payload).

### Caret-/Marker-Cleanup nach Ersetzung (seit v1.5.8)

**Symptom (Bug):** In Thunderbird war der ersetzte Text im Nachgang nicht mehr editierbar — der erste Tastendruck sprang mit dem Cursor an den Textanfang.

**Ursachen (zwei, beide im Direct-Write-Pfad der ContentEditable-Ersetzung):**

1. **Selection-Desync**: `finalizeCEMultiline`/`finalizeCEFrozen`/`replaceFullTextInElement` schreiben roh ins DOM (Range-Mutationen, `innerText`), setzen danach aber die Live-Selection **nie** neu. Der Gecko-HTMLEditor des Compose-Fensters besitzt eigenen Selection-/Transaktions-State wie ein Framework-Editor — beim nächsten Tastendruck re-adressiert er die verwaiste Selection und landet am Feldanfang.
2. **Marker-Knoten akkumulieren**: der Streaming-Marker-Modus (`ceStart`/`ceEnd`, leere Textknoten) wird nur aus der WeakMap gelöscht, nie aus dem DOM — pro Ersetzung bleiben 2 leere Knoten (+ Range-Split-Fragmente) im Mail-Body, die auch serialisiert versendet wurden.

**Fix (v1.5.8), zweiteilig:**

- **Thunderbird-Pipeline**: `isThunderbirdUA()` (UA-Sniff, testbar via Parameter) macht `isFrameworkManagedCE()` im TB-Compose true → alle Writes laufen über `execInsertTextCE` (Editor-Transaktionen, Selection bleibt konsistent). Firefox/Chrome ohne Framework-Signale nehmen weiterhin die Direct-Write-Pfade.
- **`finalizeCEState(el)`** (Defense in depth, wird in `finish`/`onError`/`onAborted` vor `cleanedSelection.delete` aufgerufen): entfernt Marker- **und** Range-Split-Fragmente (leere Textknoten), re-anchort die Live-Selection ans Ende des Ergebnisses (bzw. an die alte Selektionsstelle bei Leer-Ergebnis). `anchorCaretAtEnd()` deckt zusätzlich Ganzfeld (`innerText`) und Undo-Restore (`innerHTML`) ab.

Test: `test-ce-finalize.js` (node). jsdom-Endzustands-Verifikation: `~/workspace/llm-tb-caret-debug/run-harness-e2e.js` (außerhalb des Repos).

### Gestapelte Text-Kopien bei Ganzfeld-Ersetzung (Fix seit v1.5.9)

**Symptom (Bug):** In Thunderbird füllte sich der Mail-Body bei einer Aktion auf den gesamten Text mit wiederholten, von hinten schrumpfenden Kopien des Textes (jede Kopie endete einen Token früher; der korrekte finale Text stand am Ende).

**Ursache:** Das Ganzfeld-Streaming schrieb bei jedem Token den kompletten Text neu — pro Token Select-All + `insertText` über die Editor-Pipeline (`execSetCEText`). Wenn die interne Selection des HTMLEditor veraltet war (z. B. nach dem Fokus-Wechsel durch das Compose-Toolbar-Popup), behandelte die Engine das Insert als Einfügen am Caret statt als Ersetzen: pro Token stapelte sich ein vollständiger Snapshot.

**Fix (v1.5.9), dreiteilig:**
- **Ganzfeld-Streaming gepuffert**: `startFullTextReplacement` schreibt bei Framework-/TB-Editoren (`isFrameworkManagedCE`, inkl. UA-Check) nur EINMAL am Stream-Ende (`finish`/`onAborted`) statt pro Token. Normale CE-Felder behalten das Live-Streaming.
- **`applyChunk` (Framework-Zweig) einheitlich**: auch der Frozen-Modus (Selektion ohne Range) schreibt nur noch am Ende.
- **`execSetCEText` gehärtet**: nach Select-All + `insertText` wird verifiziert, dass das Feld wirklich nur den neuen Text enthält. Falls die Engine eingefügt statt ersetzt hat, folgt ein Pipeline-Delete + ein Retry; scheitert auch das, Rückgabe `false` → Aufrufer fällt auf Direct-Write-Pfade zurück.

Test: `test-exec-set-ce.js` (Replace-Engine ohne Korrekturschritt, Stack-Engine mit Detektion+Retry, Broken-Engine → `false`).

### Fehlende Zeilenumbrüche bei Selektions-Ersetzung (Fix seit v1.5.10)

**Symptom (Bug):** In Chrome wurden bei der Ersetzung einer mehrzeiligen Selektion die Zeilenumbrüche verworfen — das Ergebnis landete als eine Zeile im Feld.

**Ursache:** `getElementSelection` las den CE-Selektionstext per `range.toString()`. Laut DOM-Standard konkateniert das nur Textnodes — **ohne** `\n` an `<br>`- oder Blockgrenzen (anders: `Selection.toString()`).

**Fix (v1.5.10):** `selection.toString()` statt `range.toString()` in `getElementSelection` (CE-Zweig).

**Merkregel:** Der **Quelltext** einer Selektion (LLM-Input) muss Zeilenumbrüche enthalten — immer `selection.toString()` (oder INPUT/TEXTAREA-Substring). `range.toString()` niemals für Quelltext verwenden.

### Free Prompt öffnet kein Fenster in Thunderbird (Fix seit v1.5.11)

**Symptom (Bug):** In Thunderbird öffnete der „Free prompt"-Eintrag im Compose-Toolbar-Popup kein Chat-Fenster — der bestehende Mailtext wurde stattdessen direkt ersetzt.

**Ursache:** Das Compose-Toolbar-Popup kann den Compose-Tab nicht direkt message'n (kein Tab-Kontext), daher leitet `background.js` den Klick als `composePopupTrigger` weiter — und routet das als `{ action: "contextMenuProcess" }` an den Content-Script. Der Handler kannte aber nur den Browser-Kontextmenü-Pfad und schickte `textAction === "freePrompt"` ungeprüft in die **Ganzfeld-Ersetzungs-Pipeline**.

**Fix (v1.5.11):** `textAction === "freePrompt"` short-circuitet im `contextMenuProcess`-Handler **vor** `handleContextMenuProcess`: `uiSuspended = false`, Ziel-Feld per `resolveFreePromptTarget()`, dann `openFreePromptChat()`.

**Merkregel:** Jede neue `textAction`, die über `contextMenuProcess` ankommt, muss im Content-Handler **vor** `handleContextMenuProcess` behandelt werden.

Test: `test-free-prompt-route.js` (node).

### Shadow-DOM-blinde Feld-Erkennung (Fix seit v1.5.12 — Reddit)

**Symptom (Bug):** Editoren in Shadow Roots (Reddits Lit-basierter Kommentar-Composer) wurden nie erkannt — das Floating-Icon erschien nicht.

**Ursache:** Der alte `MutationObserver` + `querySelectorAll`-Scan + Per-Feld-Focus-Listener sieht keine Elemente in Shadow Roots; `document.activeElement` retargetet auf den Shadow-Host.

**Fix (v1.5.12):** EIN delegierter `focusin`-Listener auf dem Document (composed Event kreuzt Shadow-Grenzen), `findTextInputOnPath(e.composedPath())` für das echte innere Feld (deckt auch closed roots ab), `resolveEditingTarget()` (steigt `shadowRoot.activeElement` ab, Guard 32) als **der** Feld-Resolver für Shortcut/Kontextmenü/Free-Prompt/Legacy, `isNodeInDocument()` (`isConnected`) statt `document.contains()`.

**Merkregel:** Keine `querySelectorAll`-Feld-Scans, keine Per-Feld-Focus-Listener und kein rohes `document.activeElement` zur Feld-Auflösung wieder einführen.

### iframe-Editoren unsichtbar (Fix seit v1.5.13 — Teams)

**Symptom (Bug):** Teams' Compose-Box liegt in einem iframe; ohne `all_frames` lief das Content-Script dort nie — kein Teams-Feld wurde **jemals** erkannt.

**Fix (v1.5.13):** `all_frames` + `match_about_blank` im Root-Manifest **und** im Firefox-Overlay (TB braucht beides nicht — `scripting.compose.registerScripts` injiziert nativ in alle Compose-Frames). `background.js` routet frame-sensitiv: Selektions-Capture `frameIds: [info.frameId]`, `contextMenuProcess` mit `{ frameId: info.frameId }` als sendMessage-**Options-Argument** (3. Position: message, options, callback — ein Callback dort schluckt das Targeting still), content-originated Messages tragen `sender.frameId`, `injectReplacement` baut sein Target bedingt (nie `frameIds: undefined`).

Test: `test-frame-routing.js` (node) — M-Gruppe (Manifeste), F-Gruppe (frame-sensitiver Routing-Pfad).

### Teams: Icon sichtbar, Text nie ersetzt (Fix seit v1.5.14 — React)

**Ursache:** Teams' Editor ist ein React-gerendertes `contenteditable` ohne Editor-Library-Signale → `isFrameworkManagedCE()` false → direkter `innerText`-Write → React reconciled aus seinem Modell und verwirft die unmodellierte Mutation.

**Fix (v1.5.14), zweiteilig:**
1. 6. Signal in `isFrameworkManagedCE()` — Framework-State-Präfix-Match (`__reactFiber$`, `__reactInternalInstance$`, `__vue__`, `__vueParentComponent`, `__ngContext__`) auf `Object.keys(el)` **und** dem direkten Parent (State sitzt oft auf einem Wrapper-div) → Pipeline-Routing + gepufferter Ganzfeld-Write.
2. `replaceFullTextInElement()` CE-Zweig: Read-back-Verifikation via `readBackMatches()` (whitespace-normalisierter Vergleich; `beforeText`-Snapshot **muss vor** dem Write genommen werden), Sync-Check + verzögerter 350-ms-Check, Pipeline-Retry via `execSetCEText` nur wenn das Feld exakt den Pre-Replacement-Text zeigt.

### Teams: CKEditor-Modell-Writes (Fix seit v1.5.15)

**Ursache:** Teams' Compose ist CKEditor-basiert (`div[data-tid="ckeditor"]`), **nicht** Draft.js. CKEditor nimmt execCommand-Writes in den DOM, aber **nie** in sein Modell — perfekter DOM-Read-back, stiller Revert beim nächsten Render-Zyklus. DOM-Read-backs sind gegen das Modell strukturell blind.

**Fix (v1.5.15):** Der einzige Eingabepfad, aus dem modell-besitzende Editoren ihr Modell neu aufbauen, ist ein synthetischer Paste (`ClipboardEvent` + `DataTransfer`, kein `isTrusted`-Check), davor DOM-Select-All + ~350 ms Pause (CK konvertiert DOM→Modell-Selektionen nur async/debounced). Gestaffelte, verifizierte Kette `scheduleFrameworkPasteWrite` (Stage 0 Sync-Pipeline → Gate; Stage 1 Select+Pause+Paste → Gate; Stage 2 Pipeline-Delete + Paste am Caret → Gate; Stage 3 Stop). `pasteWriteToken` bricht bei neuer Aktion/Undo ab. TB behält die Sync-Pipeline.

**Editor-Polarität:** Draft.js ignoriert Paste an Modell-Position 0, akzeptiert aber execCommand; CKEditor ist umgekehrt.

E2E: `~/workspace/llm-e2e/test-teams-editor.html` gegen echtes CKEditor 5.

## v1.6.0 — Seitenkontext, Diff-Vorschau, Model-Liste

Drei opt-in Features. Neue Storage-Keys: `contextEnabled` (bool, Default `false`),
`pageContextChars` (String, Default `"600"`, `0` = aus), `confirmBeforeReplace`
(bool, Default `false`). Alle drei stehen in `DEFAULT_KEYS` in **beiden**
Background-Dateien. Der abgerufene Modell-Katalog liegt unter `modelsList` und ist
**kein** `DEFAULT_KEYS`-Eintrag (Fetch-Cache, nie ein Formularfeld).

### Seitenkontext im Free-Prompt-Chat

- `collectPageContext(el, maxChars)` sammelt Seitentitel, URL und die Absätze direkt
  um das Feld (je max. 4 Geschwister davor/danach, in Dokument-Reihenfolge).
  Der Feldinhalt selbst wird **bewusst nicht** eingefügt — er ist bereits der
  Chat-Kontext; Duplikate kosten nur Kontextfenster. `maxChars <= 0` → `""`.
- `buildInitialChatMessages()` hängt den Kontext unter dem Key `contextIntroLabel`
  an den System-Prompt — klar als Hintergrundinfo gelabelt, damit das Modell den
  Seitentext nicht als Aufgabe missversteht.
- Toggle sitzt im Chat-Header (`#llm-chat-context-toggle`, pro Sitzung), die
  Options-Seite setzt Default + Zeichen-Cap. Default aus (Datenschutz).
- Preset-Chips (`CHAT_PRESETS`, `createChatPresets`) füllen nur das Eingabefeld
  und senden **nie** automatisch — bewusste Nutzersteuerung.

### Diff-Vorschau vor dem Ersetzen

- `diffWords(oldText, newText)` — Wort-Level-Diff per LCS-DP, ohne Abhängigkeit.
  Oberhalb von 1200 Tokens pro Seite fällt sie auf einen `del`+`ins`-Block zurück
  (Schutz vor riesigen Allokationen). `renderDiffInto()` markiert Entfernungen
  rot-durchgestrichen, Ergänzungen grün.
- `showDiffConfirm(old, neu, onApply, onDiscard)` zeigt das Overlay; `closeDiffOverlay(keepPending)`
  räumt auf. `pendingConfirm` hält die Callbacks.
- **Angeklemmt an alle drei Finish-Pfade:** `startFullTextReplacement.finish`,
  `startSelectionReplacement.finish` und `applyLastResult` (Chat-Übernahme).
  Zusätzlich in den beiden Legacy-Message-Pfaden (`replaceFullText`,
  `replaceSelectedText` — Background-Fallback ohne Streaming-Port), die den
  Diff ebenfalls erst nach Bestätigung schreiben.
- **Während des Streamings wird nichts geschrieben** (Fix v1.6.4): beide
  Streaming-Pfade fixieren die Entscheidung beim Start als `const deferWrite =
  confirmBeforeReplace;`. Ganzfeld buffert dann (`bufferStream = deferWrite ||
  frameworkCE`), die Selektion verwirft Non-Final-Chunks
  (`applyChunk`: `if (deferWrite && !isFinal) return;`). Erst „Übernehmen"
  schreibt. Vorher schrieb das Live-Streaming das Ergebnis Token für Token ins
  Feld, sodass es schon vor der Bestätigung dastand.
- `confirmBeforeReplace` wird in `init()` in eine Content-Script-Variable gespiegelt
  (storage get + `onChanged`), damit die Stream-Finish-Hot-Paths ohne async-Read
  verzweigen können. **Weitere Confirm-Gates genauso spiegeln.** Die Entscheidung
  pro Lauf wird trotzdem beim Start eingefroren (`deferWrite`), damit ein
  Umschalten mitten im Stream kein halb geschriebenes Feld erzeugt.
- Die Vorschau berührt die Ersetzungs-Pipeline **nicht** — sie verzögert nur den
  bestehenden `finish`-Callback.

Test: `test-confirm-before-replace.js` (Gate in allen Schreibpfaden, Discard
schreibt nicht zurück, Legacy-Pfade gegated) + E2E
`~/workspace/llm-e2e/run-confirm-before-replace.sh` (echtes `content.js` in
headless Chromium, prüft Feldzustand vor/nach Übernehmen bzw. Abbrechen).

### Model-Liste vom Endpunkt

- `modelsUrlFromApiUrl(apiUrl)` leitet `GET <base>/models` ab (`…/v1/chat/completions`
  → `…/v1/models`; sonst Basis + `/models`).
- `fetchModelList(apiUrl, apiKey)` läuft im Background (nicht der CSP der Seite
  unterworfen), 15-s-Timeout, akzeptiert `{data:[{id}]}`, `{models:[…]}` und ein
  nacktes Array. Ein `TypeError` aus `fetch` ist fast immer CORS/DNS und wird
  als solches gemeldet (`CORS/DNS (<url>)`) statt als nacktes „Failed to fetch".
- In **beiden** Backgrounds implementiert und über die Runtime-Message `listModels`
  erreichbar; die Options-Seite ruft es aus `fetchModels()` und füllt die
  `<datalist id="modelList">` am Modellfeld.
- Lokale Endpunkte brauchen CORS für die Extension-Origin (`--allow-origins` /
  `OLLAMA_ORIGINS`) — sonst schlägt der Abruf trotz laufendem Server fehl.

Test: `test-v16-features.js` (diffWords, modelsUrlFromApiUrl, collectPageContext).

## v1.6.2 — Store-Ablehnung behoben (Extension lud gar nicht)

**Symptom:** Der Chrome Web Store lehnte v1.6.0 und v1.6.1 mit dem generischen Grund
„Der Artikel funktioniert nicht wie angekündigt" ab (Richtlinie: *Erweiterungen mit
fehlerhafter Funktionalität*). Lokal war alles grün.

**Ursache:** `_locales/{de,en}/messages.json` → `optionsModelsLoaded` (neu in v1.6.0,
Model-Listen-Feature) enthielt `"$COUNT$ models found"` **ohne** `placeholders`-Block.
Chrome bricht beim Parsen der Locale-Datei das **komplette Laden der Extension** ab:

```
Extension error: Fehler beim Laden der Erweiterung aus: <dir>.
Variable $COUNT$ used but not defined.
```

Die Extension erschien damit im Chrome des Prüfers **überhaupt nicht** — daher „funktioniert
nicht wie angekündigt". Firefox/Thunderbird sind an dieser Stelle toleranter, weshalb der
Fehler beim Entwickeln auf Gecko nicht auffiel.

**Fix:** `placeholders: { "count": { "content": "$1" } }` in beiden Locale-Dateien
(der Aufruf `t('optionsModelsLoaded', String(n))` blieb unverändert).

**Neue Absicherungen:**

- `node tools/build.mjs` bricht jetzt ab, wenn ein `$NAME$` in einer Message keinen
  `placeholders`-Eintrag hat (`$$` = literales Dollarzeichen, wird nicht geprüft).
- `node test-locale-placeholders.js` prüft dasselbe standalone (läuft im CI-Test-Job mit).
- `python3 tools/chrome-load-check.py` lädt `build/chrome` in ein echtes Chrome (Xvfb)
  und meldet Ladefehler aus dem Chrome-Log — der einzige Check, der diese Fehlerklasse
  wirklich sieht.

**Regel:** Jeder `$NAME$`-Token braucht einen `placeholders`-Eintrag in **beiden** Sprachen.
Nach jeder Locale-Änderung `node tools/build.mjs --no-zip && python3 tools/chrome-load-check.py`.

## v1.6.3 — Tastenkürzel gewinnen immer (document_start-Guard)

**Symptom:** Auf Seiten mit eigenen Shortcuts löste das Add-in-Kürzel nicht (oder nicht
zuverlässig) aus — die Seite hatte Vorrang.

**Ursache:** Der Listener hing auf `document` in der Capture-Phase und wurde erst bei
`document_end` registriert. Damit verliert er in drei Fällen:

1. **`window` schlägt `document`**: Die Capture-Reihenfolge ist `window` → `document` →
   Ziel. Ein Seiten-Listener auf `window` (Capture) läuft immer vor jedem
   `document`-Listener — unabhängig vom Registrierungszeitpunkt. Ruft er zusätzlich
   `stopPropagation()`, sieht der Content-Script-Listener das Event nie.
2. **Registrierungsreihenfolge auf demselben Knoten**: Seiten-Skripte laufen vor
   `document_end`; ein Seiten-Listener auf `document` (Capture) war also zuerst dran.
3. **`stopPropagation()` ≠ `stopImmediatePropagation()`**: `stopPropagation()` stoppt nur
   die weitere Ausbreitung, nicht die restlichen Listener **auf demselben Knoten**. Ein
   vorher registrierter Seiten-Listener auf demselben Knoten läuft trotzdem.

**Fix (v1.6.3):** Neues Root-Script `shortcuts.js`, per zweitem `content_scripts`-Eintrag
mit `run_at: "document_start"` (vor **jedem** Seiten-Skript) in allen Frames injiziert.
Es ist damit der **erste** Listener auf `window` in der Capture-Phase — die früheste
Position im Ausbreitungspfad überhaupt.

- **Rollenverteilung:** `shortcuts.js` besitzt nur das **Verschlucken**, `content.js`
  weiterhin die **Entscheidung** (Aktions-Config + Feld-Erkennung). Da beide im selben
  Isolated World laufen, übergibt `content.js` seinen Handler als globales
  `globalThis.__llmShortcutGuard`; der Guard ruft ihn bei jedem keydown auf.
- **Hook-Vertrag:** `handleShortcutKeydown(e)` gibt jetzt den getroffenen Kürzel-String
  zurück (sonst `null`). Nur ein truthy Ergebnis lässt den Guard das Event konsumieren
  (`preventDefault` + `stopImmediatePropagation`). Ohne fokussiertes Textfeld, bei
  ungebundenen Kombinationen und solange der Hook noch nicht installiert ist, bleibt der
  Guard ein No-op — die Seite behält ihre eigenen Kürzel.
- **keyup wird mitverschluckt:** Seiten, die Shortcuts auf `keyup` implementieren
  (Mousetrap-Stil), verlieren ebenfalls. Gemerkt wird nur die tatsächlich konsumierte
  Kombination; `window`-`blur` setzt sie zurück.
- **Fallback bleibt:** `content.js` registriert seinen eigenen Listener jetzt auf
  `window` (Capture) statt `document` und nutzt zusätzlich
  `stopImmediatePropagation()`. Das deckt Targets ohne den Guard ab (Thunderbird-
  Compose-Skripte, alte Builds) und fängt den Zeitraum bis zur Hook-Installation ab.
- **Thunderbird:** Der Guard wird als eigener Compose-Script-Eintrag mit
  `runAt: "document_start"` registriert (vor `content.js`, das `document_idle` behält).
  `registerScripts` ist **all-or-nothing** — schlägt die Guard-Registrierung fehl, wird
  ohne Guard erneut registriert, damit Compose nicht komplett ausfällt.

**Tests:** `node test-shortcut-priority.js` (Manifest-`document_start`, Guard-Swallow für
keydown+keyup über ein Event-Ausbreitungsmodell, Hook-Vertrag, TB-Registrierung).
Echte-Browser-E2E (Chromium headless, Szenario A/B):
`~/workspace/llm-e2e/shortcut-guard-a.html` (Guard zuerst → Seite sieht den Keydown nicht)
und `shortcut-guard-b.html` (Seite zuerst → Seite gewinnt; belegt, warum `document_start`
nötig ist). Lauf: `chrome --headless=new --dump-dom file://…/shortcut-guard-a.html`.

## v1.6.4 — „Ergebnis vor dem Ersetzen bestätigen" schrieb trotzdem vorab

**Symptom:** Mit aktivierter Option *Sicherheit → Ergebnis vor dem Ersetzen
bestätigen* stand das Ergebnis schon vor dem Klick auf „Übernehmen" im Feld;
die Diff-Vorschau zeigte den Vergleich also gegen ein bereits überschriebenes
Feld, und „Abbrechen" musste den Originaltext zurückschreiben (und überschrieb
dabei Eingaben, die während des Wartens gemacht wurden).

**Ursache:** Das Gate war nur an den `finish`-Pfaden angeklemmt, nicht am
Streaming. Beide Stream-Pfade schrieben weiter Token für Token ins Feld:

- `startFullTextReplacement.onToken` → `replaceFullTextInElement(el, accumulated)`.
  `bufferStream` war nur für framework-verwaltete ContentEditables true —
  Textareas, Inputs und einfache ContentEditables streamten live.
- `startSelectionReplacement.onToken` → `applyChunk(accumulated, false)`, ohne
  jede Bedingung.

**Fix:** Die Entscheidung wird beim Start eines Laufs eingefroren
(`const deferWrite = confirmBeforeReplace;`) und an der Schreibgrenze geprüft:

- Ganzfeld: `bufferStream = deferWrite || (el.isContentEditable && isFrameworkManagedCE(el))`
  → es wird genau einmal geschrieben, im `applyResult` nach der Bestätigung.
  `onError`/`onAborted` schreiben nur noch zurück, wenn tatsächlich gestreamt
  wurde (`if (!deferWrite) …`).
- Selektion: `applyChunk` verwirft Non-Final-Chunks (`if (deferWrite && !isFinal) return;`);
  nur der finale Write aus dem „Übernehmen"-Callback passiert das Gate. Der
  Discard-Pfad schreibt **nicht** mehr `originalFullText` zurück — es wurde
  nichts geschrieben.
- Legacy-Message-Pfade (`replaceFullText`, `replaceSelectedText`; Background-
  Fallback ohne Streaming-Port) hängen jetzt ebenfalls an `showDiffConfirm`;
  der bisherige Sofort-Schreiber heißt `replaceSelectedTextImmediate`.

Weil `deferWrite` pro Lauf fixiert ist, führt ein Umschalten der Option mitten
im Stream nicht zu einem halb geschriebenen Feld: der laufende Lauf behält
seine Policy.

**Tests:** `node test-confirm-before-replace.js` (sliced die Funktionen aus
`content.js` und prüft das Gate in allen vier Schreibpfaden; schlägt auf dem
Code vor dem Fix mit 14 Checks fehl) + E2E
`~/workspace/llm-e2e/run-confirm-before-replace.sh` (lädt das echte `content.js`
mit gestubbter `chrome.*`-API in headless Chromium und prüft Feldzustand vor
und nach Übernehmen/Abbrechen für Ganzfeld, Selektion im Textarea, Selektion im
ContentEditable, Legacy-Pfad, Abbruch und „Option aus").

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
   **Kritisch:** Ein `$NAME$` in `message` OHNE passenden `placeholders`-Eintrag lässt Chrome die **gesamte Extension nicht laden** („Variable $COUNT$ used but not defined") — das ist der Grund für die Store-Ablehnungen von v1.6.0/v1.6.1 (Fix in v1.6.2). Ein literales Dollarzeichen muss als `$$` geschrieben werden.
5. **Default-System-Prompts** sind ebenfalls locale-abhängig (`defaultPromptTranslate`, `defaultPromptExpand`, …) und werden zur Laufzeit aus den Messages gebaut — nicht hartcodiert ändern, sondern in beiden Locale-Dateien.
6. **Neue Sprache hinzufügen**: neuen Ordner `_locales/<code>/` mit vollständiger `messages.json` anlegen. Die Keys müssen exakt zu `de` und `en` passen (gleiche Menge, gleiche Platzhalter).

### Konsistenz-Check

Die Locale-Key-Parität **und** die Platzhalter-Definitionen werden **vom Build geprüft**
(`node tools/build.mjs` bricht bei Abweichung ab). Zusätzlich prüft
`node test-locale-placeholders.js` alle `$NAME$`-Tokens gegen die `placeholders`-Blöcke.

**Lade-Test in echtem Chrome** (findet Fehler, die kein Node-Test sieht — die Extension
lädt dann gar nicht):

```bash
node tools/build.mjs --no-zip
python3 tools/chrome-load-check.py          # lädt build/chrome, meldet Ladefehler
```

Manuell (Key-Parität):

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

- **Priorität (seit v1.6.3):** `shortcuts.js` läuft per `run_at: "document_start"` vor jedem Seiten-Skript und ist damit der **erste** Capture-Listener auf `window`. Trifft eine Add-in-Kombination bei fokussiertem Textfeld, wird sie mit `preventDefault()` + `stopImmediatePropagation()` konsumiert — die Seite sieht das Event gar nicht, auch nicht auf `keyup`. Details: Abschnitt „v1.6.3".
- `content.js` behält seinen Listener als **Fallback** (jetzt ebenfalls `window`, Capture-Phase) und stellt dem Guard die Entscheidung über `globalThis.__llmShortcutGuard` bereit.
- Shortcuts werden **nur ausgelöst**, wenn ein Textfeld (`INPUT`, `TEXTAREA`, `contenteditable`) fokussiert ist.
- Das schwebende Menü zeigt konfigurierte Kürzel rechtsbündig neben dem Aktionsnamen an.

## Veröffentlichen (alle drei Stores)

### Release-Prinzip

**Manuell wird nur die Version erhöht — alles andere macht die GitHub Action.**

1. Version **nur** im Root-`manifest.json` erhöhen (die Overlay-Manifeste tragen keine Version; der Build injiziert sie).
2. Commit, Tag in Gitea erstellen, dann Branch **und** Tag in EINEM Befehl pushen:
   ```bash
   git tag <version>
   git push https://s1t5:${GITEA_TOKEN}@git.schrrs.de/s1t5/LLM-Text-Assistant.git main refs/tags/<version>
   ```
   Der Tag **muss** Gitea-seitig entstehen — der Push-Mirror löscht GitHub-only-Tags (siehe Spiegel-Hinweis).
3. Die GitHub Action (`.github/workflows/release.yml`, läuft auf dem GitHub-Spiegel) übernimmt:
   - `test`-Job: alle `test-*.js` (bei jedem Push)
   - `release`-Job: Build via `tools/build.mjs`, Paket-Verifikation, `gh release create` am gespiegelten Tag, veröffentlicht (kein Draft). Wird übersprungen, wenn für die Version schon ein Release existiert.
4. Fix-Commits **ohne** Version-Bump überspringen den Release sauber.
5. Store-Uploads (Chrome Web Store, AMO, ATN) bleiben manuell: Pakete aus dem GitHub-Release herunterladen und in die Developer-Dashboards laden.

### Manueller Store-Upload (aus dem GitHub-Release)

Lade `<version>-chrome.zip` / `<version>-firefox.zip` / `<version>-thunderbird.xpi` aus dem jeweiligen GitHub-Release:

- **Chrome**: [Developer Dashboard](https://chrome.google.com/webstore/devconsole) → bestehendes Paket aktualisieren.
- **Firefox (AMO)**: [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) → bestehendes Add-on → neue Version hochladen. Gecko-ID `llm-text-assistent@s1t5.dev` (seit v1.5.0; ID-Mismatch lehnt AMO beim Review ab) und `data_collection_permissions.required: ["none"]`.
- **Thunderbird (ATN)**: [addons.thunderbird.net](https://addons.thunderbird.net) → Developer-Seite → neue Version hochladen (eigene Gecko-ID `llm-text-assistent-thunderbird@s1t5.dev`).

### Spiegel-Hinweis

Der Workflow läuft auf dem GitHub-Spiegel; das Release erscheint mit kurzer Verzögerung
nach dem Gitea-Push (Spiegel-Sync je Commit, zusätzlich 8-h-Intervall als Fallback).

**Tag-Falle:** Der Gitea→GitHub-Push-Mirror **löscht** Refs, die nur auf der
GitHub-Seite existieren. Tags, die dort per `gh release create` entstehen, wurden beim
nächsten Sync entfernt — die Release-Tags 1.5.8–1.5.11 verschwanden so und die Releases
degradierten zu unsichtbaren Drafts, während CI grün blieb. Deshalb: Tag immer in Gitea
erstellen und mitpushen (Schritt 2).

**Token-Scopes:** Das hinterlegte GitHub-Token braucht `repo` **und** `workflow` — sonst
lehnt GitHub Pushes mit Workflow-Änderungen ab und der Spiegel bleibt stehen (im
Gitea-WebUI unter Repository → Einstellungen → Mirrors im `last_error` sichtbar).
