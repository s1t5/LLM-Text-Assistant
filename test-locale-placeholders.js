// Locale message placeholder check.
//
// Chrome parses _locales/<lang>/messages.json when it loads the extension and
// ABORTS the whole load when a message references a placeholder that is not
// declared:
//
//   Extension error: Fehler beim Laden der Erweiterung aus: <dir>.
//   Variable $COUNT$ used but not defined.
//
// That is a fresh-install-fatal defect — the extension never appears at all,
// which the Web Store reports as "funktioniert nicht wie angekündigt"
// (Erweiterungen mit fehlerhafter Funktionalität). It shipped in v1.6.0/v1.6.1
// via `optionsModelsLoaded` ("$COUNT$ models found" with no `placeholders`).
//
// Rules enforced here:
//   - every $TOKEN$ in a `message` must have a matching `placeholders` entry
//     (Chrome matches placeholder names case-insensitively)
//   - `$$` is an escaped literal dollar sign and is not a placeholder
//   - a placeholder `content` must be a positional ref ($1, $2, …) or a literal
//
// Default directory is __dirname, never an absolute path, so the check also
// works in CI where the checkout lives elsewhere.
'use strict';
const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || __dirname;

const problems = [];
let checked = 0;

for (const lang of ['de', 'en']) {
  const file = path.join(dir, '_locales', lang, 'messages.json');
  let dict;
  try {
    dict = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    problems.push(`_locales/${lang}/messages.json: nicht lesbar/parsebar (${e.message})`);
    console.log(`  FAIL  _locales/${lang}/messages.json lesbar`);
    continue;
  }
  console.log(`\n=== _locales/${lang}/messages.json ===`);

  for (const [key, entry] of Object.entries(dict)) {
    const msg = typeof entry === 'object' && entry !== null ? entry.message : entry;
    if (typeof msg !== 'string') {
      problems.push(`_locales/${lang}: '${key}' hat keine message`);
      continue;
    }
    checked++;

    const placeholders = (entry && entry.placeholders) || {};
    const declared = new Set(Object.keys(placeholders).map((p) => p.toLowerCase()));

    // Mask escaped literal dollars, then look for $TOKEN$ references.
    const stripped = msg.replace(/\$\$/g, '\u0000');
    for (const m of stripped.matchAll(/\$([A-Za-z0-9_]+)\$/g)) {
      if (!declared.has(m[1].toLowerCase())) {
        const p = `'${key}' nutzt $${m[1]}$ ohne passenden placeholders-Eintrag`;
        problems.push(`_locales/${lang}: ${p}`);
        console.log('  FAIL  ' + p);
      }
    }

    // A placeholder's content must resolve to something real.
    for (const [name, spec] of Object.entries(placeholders)) {
      const content = spec && spec.content;
      if (typeof content !== 'string' || !/^\$\d+$/.test(content)) {
        const p = `'${key}' placeholder '${name}' hat ungültigen content '${content}'`;
        problems.push(`_locales/${lang}: ${p}`);
        console.log('  FAIL  ' + p);
      }
    }
  }
  console.log(`  geprüft: ${Object.keys(dict).length} Messages`);
}

console.log('\n=== ERGEBNIS ===');
if (problems.length) {
  console.log(`  ${problems.length} Problem(e): die Extension würde in Chrome NICHT laden.`);
  process.exit(1);
}
console.log(`  Alle ${checked} Messages haben definierte Platzhalter.`);
