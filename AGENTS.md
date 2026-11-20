# AGENTS.md

Arbeitsanweisung für Agenten in diesem Repo: **LLM Text Assistent**, eine
Manifest-V3-Erweiterung für Chrome, Firefox und Thunderbird.

Hier stehen nur Regeln, die für jede Änderung gelten. Die Versionshistorie steht in
`README.md` (Englisch) und im Git-Log; ein behobener Fehler erscheint hier nur noch als
Invariante (nie X, weil Y), nicht als Erzählung.

## Projektstruktur (Trunk + Plattform-Overlays)

| Datei/Ordner | Zweck |
|---|---|
| `manifest.json` | Chrome-Manifest (MV3) und **einzige Quelle der Versionsnummer** |
| `background.js` | Service Worker: Kontextmenü, API-Calls, Streaming, Retry/Abort, Model-Liste |
| `content.js` | Text-Ersetzung, schwebendes Icon, Chat, Diff-Vorschau, Undo-Toast |
| `shortcuts.js` | Shortcut-Guard, eigener `content_scripts`-Eintrag mit `document_start` |
| `options.html` / `options.js` | Einstellungsseite |
| `_locales/{de,en}/` | i18n, siehe unten |
| `platform/firefox/manifest.json` | Gecko-Overlay (Gecko-ID, `strict_min_version`), **ohne** `version` |
| `platform/thunderbird/` | TB-Overlay: `manifest.json`, `background.js` (Compose-Injection), `popup.html`/`popup.js` |
| `tools/build.mjs` | baut `build/{chrome,firefox,thunderbird}`, injiziert die Version, validiert, packt `dist/<version>-<target>.{zip,xpi}` |
| `test-*.js` | Node-Tests, slicen Funktionen aus den ausgelieferten Quellen |

`build/`, `dist/` und `Pub/` sind generiert oder historisch: nicht editieren, nicht
committen. Neue Root-Dateien müssen in `sharedFiles` in `tools/build.mjs` eingetragen
werden, sonst landen sie in keinem Build.

### Build

```bash
node tools/build.mjs            # alle drei Targets bauen und packen
node tools/build.mjs --no-zip   # Verifikations-Build ohne Pakete
node tools/build.mjs firefox    # einzelnes Target
```

Der Build prüft JS-Syntax (`node --check`), Versionsformat `x.y.z`, Locale-Key-Parität
`de`/`en`, die i18n-Platzhalter und die Vollständigkeit der Overlays. Bei Fehlern bricht
er mit Exit-Code ≠ 0 ab. Die Version wird nur im Root-`manifest.json` gepflegt und beim
Build in die Overlay-Manifeste injiziert.

### Tests

```bash
node test-insert-ce.js              # execInsertTextCE-Kommando-Sequenzen je Engine
node test-linebreaks.js             # \n vs. \n\n, CRLF, blockbewusste Leseseite
node test-ce-finalize.js            # Marker-/Fragment-Cleanup, Caret, TB-Pipeline-Routing
node test-exec-set-ce.js            # Ganzfeld-Write-Verifikation (Replace/Stack/Broken)
node test-ui-host-survival.js       # UI-Host überlebt Ganzfeld-Write (Thunderbird)
node test-tb-icon-visibility.js     # Icon-Sichtbarkeit im TB-Compose (Blur/Focus)
node test-free-prompt-route.js      # contextMenuProcess-Routing und Focus-Erkennung
node test-frame-routing.js          # all_frames und frame-sensitives Message-Routing
node test-v16-features.js           # diffWords, modelsUrlFromApiUrl, collectPageContext
node test-shortcut-priority.js      # document_start-Guard, Swallow-Logik, Hook-Vertrag
node test-confirm-before-replace.js # Confirm-Gate in allen Schreibpfaden
node test-chat-focus-restore.js     # Caret nach dem Free-Prompt-Chat
node test-caret-anchor.js           # Caret-Anker nach Ganzfeld-Write
node test-custom-action-ids.js      # Custom-Action-IDs in beiden Backgrounds
node test-settings-consistency.js   # DEFAULT_KEYS/buildDefaultConfig/Options/BUILTIN_FIELDS
node test-locale-placeholders.js    # jeder $NAME$-Token hat einen placeholders-Eintrag
```

Alle `test-*.js` laufen im CI-Test-Job bei jedem Push. Die Tests slicen Funktionen per
String-Slicing aus den ausgelieferten Quellen und werten sie aus, sie testen also echten
Code. Default-Pfade immer über `__dirname` oder relativ, nie absolut: ein absoluter Pfad
ist lokal grün und in CI rot. Freie Variablen einer geslicten Funktion müssen als
`new Function`-Parameter übergeben werden, sonst schlägt der Test ohne Codefehler fehl.

Zusätzlich:

```bash
node tools/build.mjs --no-zip && node tools/store-boot-check.js   # onInstalled-Seeding
python3 tools/chrome-load-check.py                                # lädt build/chrome in echtes Chrome
```

`chrome-load-check.py` ist der einzige Check, der sieht, ob Chrome das Paket überhaupt
lädt (Xvfb, Exit 2 = kein Chrome gefunden, CI behandelt das als Warnung). Browser-E2E-
Harnesses liegen außerhalb des Repos unter `~/workspace/llm-e2e/`.

## Thunderbird-Variante

| Bereich | Browser | Thunderbird |
|---|---|---|
| **Injection** | `content_scripts`, `matches: ["<all_urls>"]`, `all_frames`, `match_about_blank` | `scripting.compose.registerScripts()` (MV3 ab TB 128), beim Start zusätzlich `executeScript` für bereits offene Compose-Tabs |
| **Einstieg** | Kontextmenü, Floating-Icon, Shortcuts | Compose-Toolbar-Popup (`compose_action`), Floating-Icon, Shortcuts; **keine Kontextmenüs** |
| **Permissions** | `contextMenus`, `scripting`, `activeTab`, `storage` | `compose`, `scripting`, `storage` |
| **Gecko-ID** | `llm-text-assistent@s1t5.dev` | `llm-text-assistent-thunderbird@s1t5.dev` |
| **Min-Version** | FF 109 | TB 128 |
| **`background.js`** | Root-Version | Overlay, divergiert: Kontextmenü raus, Compose-Injection rein |

`content.js`, `options.*` und `_locales/` sind für alle Targets identisch. Die
Text-Ersetzung im Compose-Fenster nutzt dieselben Pfade: HTML-Body ist
`contenteditable`, Plaintext-Body `textarea`, Betreff `input`.

- `platform/thunderbird/background.js` ist eine eigene Kopie. Änderungen an geteilten
  Funktionen (Prompt-Aufbau, HTTP-Layer, Streaming, Model-Liste) in **beiden** Dateien
  machen. `DEFAULT_KEYS` und `buildDefaultConfig()` synchron halten.
- `registerScripts` ist all-or-nothing: schlägt ein Eintrag fehl, ohne ihn erneut
  registrieren, sonst fällt Compose komplett aus.
- `suspendUi` hängt das UI vor dem Senden ab.

## Text-Ersetzungs-Architektur

Jede Regel über das Schreiben von LLM-Ergebnissen muss **jede** Schicht treffen:
`applyChunk` (Streaming), `replaceSelectedText`/`replaceFullText` (Legacy-Message) und
`injectReplacement` in `background.js` (Root; das TB-Overlay ist ein No-Op). Sonst
divergieren Streaming-, Legacy- und Fallback-Pfad still.

### Invarianten

1. **Zeilenumbruch ≠ Absatz.** `\n` ist ein weicher Umbruch (`insertLineBreak` → `<br>`),
   `\n\n` ein Absatz (`insertParagraph`, Fallback zwei `insertLineBreak`). Zusätzliche
   Leerzeilen ergeben zusätzliche Absätze, `\r\n`/`\r` werden vorher normalisiert. Gelesen
   wird mit `rangeToSourceText(range, root)`: `<br>` → `\n`, Blockgrenze → `\n\n`, nie
   stapeln. `getElementSelection` (CE-Zweig) und `getElementFullText` nutzen beide diesen
   Leser, damit Schreib- und Leseseite dieselbe Sprache sprechen.
2. **Quelltext einer Selektion** muss Zeilenumbrüche enthalten: im CE `rangeToSourceText`
   (blockbewusste Obermenge von `selection.toString()`), in INPUT/TEXTAREA der
   `value`-Substring. `range.toString()` niemals für Quelltext, es konkateniert
   Textknoten ohne Umbrüche.
3. **Ganzfeld-Writes bei Framework- und TB-Editoren werden gepuffert.**
   `isThunderbirdUA()` macht `isFrameworkManagedCE()` im TB-Compose true, damit alle
   Writes über die Editor-Pipeline laufen. Ein Select-All plus `insertText` pro Token
   stapelt komplette Snapshots, wenn die Editor-Selection veraltet ist. Einmal schreiben
   am Stream-Ende, einfache CEs streamen weiter live.
4. **`execSetCEText` verifiziert.** Nach Select-All und `insertText` wird geprüft, ob das
   Feld wirklich nur den neuen Text enthält. Sonst Pipeline-Delete plus ein Retry, sonst
   `false`, und der Aufrufer fällt auf den Direkt-Write zurück. Für den Direkt-Write gilt:
   `beforeText` **vor** dem Write snapshotten, `readBackMatches()` synchron und verzögert
   (350 ms) prüfen, Pipeline-Retry nur, wenn das Feld exakt wieder den alten Text zeigt.
5. **Modell-besitzende Editoren brauchen Paste, nicht execCommand.** CKEditor und
   Konsorten übernehmen execCommand in den DOM, aber nie ins Modell: perfekter Read-back,
   stiller Revert. `scheduleFrameworkPasteWrite` schreibt gestaffelt und verifiziert
   (Stage 0 Pipeline, dann Select plus 350 ms Pause plus Paste, dann Delete plus Paste am
   Caret, dann Stop). `pasteWriteToken` bricht bei neuer Aktion oder Undo ab. Polarität:
   Draft.js ignoriert Paste an Modellposition 0 und akzeptiert execCommand, CKEditor ist
   umgekehrt. Thunderbird behält die synchrone Pipeline.
6. **`execCommand` ist in Gecko asynchron.** Nach dem Aufruf zeigt der DOM noch den alten
   Text. Niemals in derselben Task zurücklesen: einmal schreiben, `settle` abwarten
   (2×rAF plus kurzer Timeout), dann prüfen (350 ms). Ein synchroner Read-back erklärt
   einen korrekten Write für gescheitert und startet die Reparatur-Schleife.
7. **UI im editierbaren Bereich.** Im TB-Compose ist `document.body` der Mail-Body, der
   UI-Host (`#llm-assistant-ui-host`, closed shadow root) hängt als Kind darin. Jeder
   `selectNodeContents`-Write würde ihn löschen: `detachUiHostWithin(el)` entfernt ihn für
   die Dauer des Writes und hängt ihn im `finally` zurück (in `execSetCEText`, im
   Undo-Pipeline-Zweig und beim direkten `innerText`-Write). Jede gecachte UI-Referenz vor
   Benutzung auf `isConnected` prüfen (`dropStaleUiRefs`).
8. **Caret-Anker: letzter echter Textknoten, nie Editing-Host-Ebene.**
   `anchorCaretAtEnd(el)` läuft vom Feldende rückwärts und überspringt UI-Host,
   abschließende `<br>`-Platzhalter, leere Blöcke und Textknoten der Länge 0. Ein Ergebnis
   mit abschließendem Umbruch hinterlässt genau solche Knoten. Fallback ist `(el, 0)`.
   `settleCaretAfterPipelineWrite(el, expectedText)` wiederholt den Anker nach dem Write
   (2×rAF, 250 ms, 600 ms), nur solange Feld-Fokus und Ergebnis stimmen; jeder echte
   Nutzer-Input gewinnt (`userInteractToken`, gepflegt von `pointerdown`/`keydown`).
9. **Overlays geben Fokus und Selection zurück.** Vor dem Entfernen des Chats
   `dropUiSelection()` (eine Selection im eigenen Shadow Root wird sonst abgehängt, Gecko
   malt keinen Caret). `restoreEditorFocus` setzt den Caret und wiederholt das asynchron
   (2×rAF, 200 ms, 600 ms); `captureCaretRange` fällt auf `rememberFieldCaret` zurück
   (gemerkt bei jedem `selectionchange`), wenn das Compose-Popup Fokus und Live-Selection
   genommen hat. Gegen einen schon fokussierten Host braucht es einen echten
   Focus-Zyklus über einen Offscreen-Sink, `focus()` allein ist in Gecko ein No-op. Ein
   Selection-Write weckt den Editor nicht: `nudgeEditorAtCaret` macht daraus einen echten
   Edit (Zero-Width-Space einfügen, Selection dahinter, wieder löschen), einmal pro Close,
   und löscht nur, wenn der Text wirklich um ein Zeichen gewachsen ist. Ohne Dokument-Fokus
   (`document.hasFocus()` false) zusätzlich `window.focus()`. Der Apply-Pfad nutzt
   `closeChatWindow({ reassert: false })`, weil der Write den Caret schon gesetzt hat.
10. **Confirm-Gate an der Schreibgrenze, nicht am Finish-Callback.** `deferWrite` wird beim
    Laufstart aus `confirmBeforeReplace` fixiert. Ganzfeld puffert dann
    (`bufferStream = deferWrite || frameworkCE`), `applyChunk` verwirft Non-Final-Chunks
    (`if (deferWrite && !isFinal) return;`). `onError`/`onAborted` schreiben nur zurück,
    wenn tatsächlich gestreamt wurde, Discard schreibt gar nichts. Die Legacy-Pfade
    (`replaceFullText`, `replaceSelectedText`, Sofort-Schreiber
    `replaceSelectedTextImmediate`) hängen am selben Gate.
11. **Feld-Erkennung über Ereignisse, nicht über Scans.** Ein delegierter `focusin`-Listener
    auf dem Document (composed, kreuzt Shadow-Grenzen), `findTextInputOnPath(composedPath)`
    für das echte Feld, `resolveEditingTarget()` (steigt `shadowRoot.activeElement` ab,
    Guard 32) als Resolver für Shortcut, Kontextmenü, Free-Prompt und Legacy,
    `isNodeInDocument()` über `isConnected` statt `document.contains()`. Keine
    `querySelectorAll`-Feld-Scans, keine Per-Feld-Focus-Listener, kein rohes
    `document.activeElement` zur Auflösung.
12. **iframes.** `all_frames` plus `match_about_blank` im Root- und im Firefox-Overlay (TB
    braucht beides nicht, `registerScripts` injiziert in alle Compose-Frames). Routing
    frame-sensitiv: Selektions-Capture `frameIds: [info.frameId]`, `contextMenuProcess` mit
    `{ frameId: info.frameId }` als **Options-Argument** (dritte Position, ein Callback dort
    schluckt das Targeting), content-originated Messages tragen `sender.frameId`,
    `injectReplacement` baut sein Target bedingt, nie `frameIds: undefined`.
13. **`contextMenuProcess`-Routing.** Jede neue `textAction`, die dort ankommt, muss im
    Content-Handler **vor** `handleContextMenuProcess` behandelt werden (`freePrompt`
    short-circuitet dort). Das TB-Popup kann den Compose-Tab nicht direkt ansprechen und
    schickt `composePopupTrigger` über den Background; solange es offen ist, ist
    `document.activeElement` der Body, deshalb löst `resolveFreePromptTarget()` das Feld
    auf (live, dann `activeInputElement`, sonst null).
14. **Custom-Action-IDs kommen aus dem Originalindex.** `loadActionsForContent()` vergibt
    `custom_<i>` **vor** dem Filter auf Aktionen mit Titel (`map` vor `filter`), weil
    `content.js` die ID gegen `config.customActions` auflöst. Nach dem Filtern verschieben
    sich sonst alle folgenden Indizes. In beiden Backgrounds.
15. **Settings-Konsistenz.** `DEFAULT_KEYS`, `buildDefaultConfig()`, `getDefaults` plus
    `BUILTIN_FIELDS` in `options.js` müssen dieselbe Menge sein, in beiden Backgrounds. Ein
    Key in `DEFAULT_KEYS` ohne Wert in `buildDefaultConfig()` seedet bei einer frischen
    Installation `undefined`. `modelsList` ist Fetch-Cache, kein Formularfeld.
16. **i18n-Platzhalter sind lebenswichtig.** Jeder `$NAME$`-Token braucht einen
    `placeholders`-Eintrag in beiden Sprachen, sonst lädt Chrome die **gesamte** Extension
    nicht („Variable $COUNT$ used but not defined"). Firefox und Thunderbird tolerieren das,
    deshalb fällt es beim Entwickeln nicht auf. Literales `$` als `$$`.
17. **Shortcut-Priorität.** `shortcuts.js` läuft per eigenem `content_scripts`-Eintrag mit
    `run_at: "document_start"` vor jedem Seiten-Skript und ist der erste Capture-Listener
    auf `window`. `content.js` behält die Entscheidung und übergibt den Handler als
    `globalThis.__llmShortcutGuard`; der Hook gibt den getroffenen Kürzel-String zurück
    (sonst `null`), nur truthy konsumiert (`preventDefault` plus
    `stopImmediatePropagation`, passendes `keyup` mit), `window`-Blur setzt zurück.
    Umgekehrt stoppt `getUiRoot()` `keydown`/`keyup`/`keypress` auf dem Shadow Root, damit
    Seiten-Shortcuts das Tippen im eigenen UI nicht verschlucken. Grenze: ein
    Capture-Listener der Seite auf `window` läuft vorher und ist nicht zu stoppen.
18. **TB-Icon.** `init()` zeigt es bei bereits fokussiertem Feld (plus 250-ms-Retry),
    `handleWindowFocus()` holt es zurück (Compose ist ein Subframe, ein Rückklick feuert
    kein `focusin`), `handleWindowBlur()` blendet aus, damit nicht zwei Icons stehen, der
    Mouseleave-Timer des Menüs ruft nur `hideActionMenu()` und löscht nicht das Icon,
    `closeChatWindow()` zeigt es wieder.
19. **Undo** stellt bei CEs das gespeicherte `innerHTML` wieder her, nie reinen Text.
20. **Marker-Cleanup.** Nach jedem Direkt-Write in ein CE läuft `finalizeCEState(el)` vor
    `cleanedSelection.delete(el)`: es entfernt Marker- und Range-Split-Fragmente (leere
    Textknoten) aus dem DOM und re-anchort die Live-Selection. Ohne das sammeln sich pro
    Ersetzung leere Knoten im Mail-Body an, die auch serialisiert versendet werden.

### Opt-in-Features (v1.6.0)

Drei zuschaltbare Funktionen mit eigenen Regeln. Ihre Storage-Keys sind `contextEnabled`
(Default `false`), `pageContextChars` (Default `"600"`, `0` = aus) und
`confirmBeforeReplace` (Default `false`), alle in `DEFAULT_KEYS` beider Backgrounds.

- **Seitenkontext** (`collectPageContext`, `buildInitialChatMessages`): sammelt Titel, URL
  und die Absätze um das Feld herum (je maximal 4 Geschwister). Der Feldinhalt selbst wird
  bewusst nicht eingefügt, er ist schon Chat-Kontext. `maxChars <= 0` liefert `""`. Der
  Kontext geht als klar gelabelte Hintergrundinfo in den System-Prompt. Default aus.
- **Diff-Vorschau** (`diffWords`, `renderDiffInto`, `showDiffConfirm`): Wort-Level-Diff per
  LCS ohne Abhängigkeit, oberhalb von 1200 Tokens pro Seite ein `del`+`ins`-Block. Die
  Vorschau berührt die Ersetzungs-Pipeline nicht, sie verzögert nur den `finish`-Callback.
- **Model-Liste** (`fetchModelList`, `modelsUrlFromApiUrl`, Runtime-Message `listModels`):
  läuft im Background, 15-s-Timeout, akzeptiert `{data:[…]}`, `{models:[…]}` und ein
  nacktes Array. Lokale Endpunkte brauchen CORS für die Extension-Origin. Die Options-Seite
  füllt damit die `<datalist id="modelList">`.
- **Preset-Chips** (`CHAT_PRESETS`, `createChatPresets`) im Chat füllen nur das
  Eingabefeld und senden nie automatisch.

## Mehrsprachigkeit (i18n)

### Aufbau

- `_locales/de/messages.json`, `_locales/en/messages.json`
- `manifest.json` hat `"default_locale": "de"` und nutzt `__MSG_key__` für Name und
  Beschreibung

### Regeln

1. Jeder neue UI-Text als Key in **beiden** Dateien, niemals hardcoden.
2. In JavaScript über `chrome.i18n.getMessage(key, subst?)`, Helper `t(key)`.
3. In HTML über `data-i18n="key"`, angewendet von `applyI18n()` in `options.js`.
4. Platzhalter als `$NAME$` mit `placeholders`-Block, Aufruf `t('key', 'Wert')`. Ohne den
   Block lädt Chrome die Extension nicht (siehe Invariante 16). Literales `$` als `$$`.
5. Default-System-Prompts (`defaultPromptTranslate`, `defaultPromptExpand`, …) sind
   locale-abhängig und werden zur Laufzeit gebaut, nicht hartcodieren.
6. Neue Sprache: `_locales/<code>/messages.json` mit exakt derselben Key-Menge und
   denselben Platzhaltern.

### Prüfen

Der Build prüft Key-Parität und Platzhalter, `test-locale-placeholders.js` prüft die
Tokens standalone, `tools/chrome-load-check.py` lädt das gebaute Chrome-Paket in echtes
Chrome. Nach jeder Locale-Änderung: `node tools/build.mjs --no-zip` und
`python3 tools/chrome-load-check.py`.

## Tastenkürzel

### Datenmodell

- `builtinShortcuts` (Storage): Objekt mit den Built-in-IDs (`translate`, `expand`,
  `summarize`, `grammar`) als Key
- `freePromptShortcut` (Storage): String für den Freier-Prompt-Shortcut
- `customActions[N].shortcut`: String direkt am Action-Objekt

### Format

`[Ctrl+][Alt+][Shift+][Meta+]<Key>`, Modifier in dieser Reihenfolge. `<Key>` ist `A`–`Z`,
`0`–`9`, `F1`–`F12`, `Enter`, `Space`, `Escape`, `Backspace`, `Delete`, `Tab`,
Pfeiltasten. macOS-`Cmd` wird intern als `Meta` gespeichert.

### Verhalten

- Priorität und Swallow-Logik: siehe Invariante 17. `content.js` behält den Fallback auf
  `window`-Capture für Targets ohne Guard.
- Kürzel lösen nur bei fokussiertem Textfeld aus (`INPUT`, `TEXTAREA`, `contenteditable`).
- Das schwebende Menü zeigt konfigurierte Kürzel rechtsbündig neben dem Aktionsnamen.

## Veröffentlichen (alle drei Stores)

### Release-Prinzip

Manuell wird nur die Version erhöht, alles andere macht die GitHub Action.

1. Version **nur** im Root-`manifest.json` erhöhen (Overlay-Manifeste tragen keine
   Version, der Build injiziert sie).
2. Commit, Tag erstellen, dann Branch **und** Tag in einem Befehl pushen:
   ```bash
   git tag <version>
   git push origin main refs/tags/<version>
   ```
   Der Tag **muss** auf dem Ursprungs-Remote entstehen, der Push-Mirror löscht
   GitHub-only-Tags (siehe Spiegel-Hinweis).
3. Die GitHub Action (`.github/workflows/release.yml`, läuft auf dem GitHub-Spiegel)
   übernimmt:
   - `test`-Job: alle `test-*.js` bei jedem Push
   - `release`-Job: Build via `tools/build.mjs`, Paket-Verifikation, `gh release create`
     am gespiegelten Tag, veröffentlicht (kein Draft). Wird übersprungen, wenn für die
     Version schon ein Release existiert.
4. Fix-Commits ohne Version-Bump überspringen den Release sauber.
5. Store-Uploads (Chrome Web Store, AMO, ATN) bleiben manuell.

### Manueller Store-Upload (aus dem GitHub-Release)

Lade `<version>-chrome.zip`, `<version>-firefox.zip` oder `<version>-thunderbird.xpi` aus
dem jeweiligen GitHub-Release:

- **Chrome**: [Developer Dashboard](https://chrome.google.com/webstore/devconsole),
  bestehendes Paket aktualisieren.
- **Firefox (AMO)**: [addons.mozilla.org/developers](https://addons.mozilla.org/developers/),
  bestehendes Add-on, neue Version hochladen. Gecko-ID `llm-text-assistent@s1t5.dev` (ein
  ID-Mismatch lehnt AMO beim Review ab) und
  `data_collection_permissions.required: ["none"]`.
- **Thunderbird (ATN)**: [addons.thunderbird.net](https://addons.thunderbird.net),
  Developer-Seite, neue Version hochladen (eigene Gecko-ID
  `llm-text-assistent-thunderbird@s1t5.dev`).

### Spiegel-Hinweis

Der Workflow läuft auf dem GitHub-Spiegel; das Release erscheint mit kurzer Verzögerung
nach dem Gitea-Push (Spiegel-Sync je Commit, zusätzlich 8-h-Intervall als Fallback).

**Tag-Falle:** Der Gitea→GitHub-Push-Mirror **löscht** Refs, die nur auf der GitHub-Seite
existieren. Tags, die dort per `gh release create` entstehen, verschwinden beim nächsten
Sync, und die Releases degradieren zu unsichtbaren Drafts, während CI grün bleibt. Deshalb
den Tag immer in Gitea erstellen und mitpushen (Schritt 2).

**Token-Scopes:** Das hinterlegte GitHub-Token braucht `repo` **und** `workflow`, sonst
lehnt GitHub Pushes mit Workflow-Änderungen ab und der Spiegel bleibt stehen (im
Gitea-WebUI unter Repository, Einstellungen, Mirrors im `last_error` sichtbar).
