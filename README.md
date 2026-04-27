# LLM Text Assistent – Chrome-Erweiterung

Eine Chrome-Erweiterung, mit der du markierten Text in Eingabemasken über ein Chat-Completions-LLM direkt verarbeiten und automatisch ersetzen lassen kannst.

## Funktionen

- **Kontextmenü-Integration**: Rechtsklick auf markierten Text in einem Eingabefeld → **„LLM Text Assistent“** mit vier Aktionen:
  1. **🌐 Ins Englische übersetzen** – Übersetzt den markierten Text ins Englische
  2. **✍️ Ausformulieren** – Formuliert Stichpunkte oder Satzfragmente zu einem vollständigen, flüssigen Text aus
  3. **📋 Zusammenfassen** – Fasst einen längeren Text kurz und prägnant zusammen
  4. **✅ Rechtschreibung & Grammatik** – Korrigiert Rechtschreibung, Grammatik und Zeichensetzung
- **Unterstützte Eingabeelemente**: `<input>`, `<textarea>` und `contenteditable`-Elemente
- **Flexible API-Konfiguration**: Kompatibel mit OpenAI, eigenen Endpunkten (z. B. Ollama, LM Studio) und anderen OpenAI-kompatiblen APIs
- **Anpassbare System-Prompts**: Lege für jede der vier Aktionen fest, wie das LLM den Text verarbeiten soll
- **Sofortige Ersetzung**: Der verarbeitete Text ersetzt automatisch die Markierung im Eingabefeld

## Dateien

| Datei | Beschreibung |
|-------|-------------|
| `manifest.json` | Erweiterungs-Manifest (Manifest V3) |
| `background.js` | Service Worker: Kontextmenü, API-Calls |
| `content.js` | Text-Ersetzung in Eingabefeldern |
| `options.html` / `options.js` | Einstellungsseite |
| `icons/icon.svg` | Erweiterungs-Icon |

## Installation & Deployment

### Voraussetzungen

- Google Chrome (Desktop) in einer aktuellen Version
- Alle Dateien dieses Repos in einem gemeinsamen Ordner

### Temporäre Installation (Entwicklung & Test)

1. **Chrome öffnen** und in die Adressleiste eingeben:
   ```
   chrome://extensions/
   ```
   Drücke `Enter`.

2. Oben rechts den Schalter **„Entwicklermodus“** aktivieren.

3. Auf den Button **„Entpackte Erweiterung laden“** klicken.

4. Im Datei-Auswahldialog den Ordner auswählen, in dem sich alle Dateien der Erweiterung befinden, und auf **„Ordner auswählen“** klicken.

5. Die Erweiterung erscheint nun in der Liste. Sie ist sofort aktiv.

> **Hinweis**: Bei einer temporären Installation bleibt die Erweiterung nach einem Chrome-Neustart erhalten, solange du den Ordner nicht verschiebst oder löschst.

### Als ZIP/Paket installieren

1. Alle Dateien in ein ZIP-Archiv packen (z. B. `LLMTextAssistent.zip`).

2. In Chrome `chrome://extensions/` öffnen und den **Entwicklermodus** aktivieren.

3. Die ZIP-Datei per **Drag & Drop** auf die Seite ziehen.

4. Chrome installiert die Erweiterung automatisch.

### Veröffentlichung im Chrome Web Store (optional)

Wenn du die Erweiterung öffentlich anbieten möchtest:

1. Einmalige Registrierung als Chrome Web Store Entwickler unter [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole).

2. Erweiterung als ZIP packen (kein `.crx` nötig).

3. Im Entwickler-Dashboard auf **„Neues Element“** klicken und das ZIP hochladen.

4. Store-Eintrag ausfüllen (Screenshots, Beschreibung, Kategorie).

5. Zum Review einreichen. Nach Freigabe ist die Erweiterung im Store verfügbar.

## Konfiguration

1. Klicke auf das Puzzle-Symbol in der Chrome-Symbolleiste, halte die Maus über **„LLM Text Assistent“** und klicke auf das Zahnrad-Symbol **„Optionen“**.

2. Trage die folgenden Werte ein:

| Einstellung | Beschreibung |
|-------------|--------------|
| **API URL** | Endpunkt für Chat Completions, z. B. `https://api.openai.com/v1/chat/completions` |
| **API Key** | Dein API-Key (falls erforderlich) |
| **Modell** | z. B. `gpt-3.5-turbo`, `gpt-4`, `llama2`, `mistral` |
| **System Prompt – Übersetzen** | Anweisung für die Übersetzung |
| **System Prompt – Ausformulieren** | Anweisung für das Ausformulieren von Stichpunkten |
| **System Prompt – Zusammenfassen** | Anweisung für die Zusammenfassung |
| **System Prompt – Rechtschreibung & Grammatik** | Anweisung für die Korrektur |
| **Temperature** | Kreativität (0–2, Standard: 0.3) |

### Beispiele für lokale Endpunkte

- **Ollama**: `http://localhost:11434/v1/chat/completions` (API-Key leer lassen)
- **LM Studio**: `http://localhost:1234/v1/chat/completions` (API-Key leer lassen)

## Nutzung

1. Markiere den gewünschten Text in einem Eingabefeld.
2. Klicke mit der rechten Maustaste auf die Auswahl.
3. Wähle im Menü **„LLM Text Assistent“** die gewünschte Aktion:
   - **🌐 Ins Englische übersetzen**
   - **✍️ Ausformulieren**
   - **📋 Zusammenfassen**
   - **✅ Rechtschreibung & Grammatik**
4. Der verarbeitete Text ersetzt automatisch die Markierung.

## Wichtige Hinweise

- **Rechte**: Die Erweiterung benötigt die Berechtigung, auf Webseiten zuzugreifen (`<all_urls>`) und Kontextmenüs zu erstellen. Dies wird bei der Installation transparent angezeigt.
- **Service Worker**: Im Gegensatz zu Firefox läuft der Hintergrundprozess in Chrome als Service Worker (Manifest V3).

## Lizenz

MIT