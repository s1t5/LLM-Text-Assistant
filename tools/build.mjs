#!/usr/bin/env node
// Build the three store packages from the single source tree.
//
// Structure (trunk + overlays): the repo root holds ALL shared sources
// (content.js, options.*, locales, icons, and the Chrome manifest as the
// canonical version carrier). platform/<target>/ contains ONLY the files
// that genuinely differ per target:
//
//   platform/firefox/manifest.json        Gecko settings block
//   platform/thunderbird/manifest.json    compose_action, permissions, ID
//   platform/thunderbird/background.js    compose-script injection
//   platform/thunderbird/popup.html|js    compose toolbar popup
//
// The build copies shared files into build/<target>/, applies the overlay,
// injects the root manifest version into every target manifest, validates,
// and zips the store packages into dist/.
//
// Usage:
//   node tools/build.mjs            # build all three targets + packages
//   node tools/build.mjs firefox    # build a single target
//   node tools/build.mjs --no-zip   # skip packaging (verification build)
//
// Exits non-zero on any validation error. No dependencies (node >= 18).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = path.join(repoDir, 'build');
const distDir = path.join(repoDir, 'dist');

// ---------------------------------------------------------------- helpers

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    problems.push(`${p}: ${e.message}`);
    return {};
  }
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) copyFile(s, d);
  }
}

const problems = [];

// Python fallback zipper (no `zip` CLI needed; deterministic order).
const ZIP_PY = `
import os, sys, zipfile
out = sys.argv[1]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in sorted(os.walk('.')):
        dirs.sort()
        for f in sorted(files):
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, '.'))
`;

const LIST_PY = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    print('\\\\n'.join(z.namelist()))
    try:
        import json
        print('VERSION:' + json.loads(z.read('manifest.json'))['version'])
    except Exception as e:
        print('VERSION:ERROR:' + str(e))
`;

function zipDirectory(dir, outPath) {
  // Node has no zip in stdlib; prefer the `zip` CLI (GitHub runners have
  // it), fall back to Python so local verification builds work everywhere.
  try {
    execFileSync('zip', ['-qr', outPath, '.'], { cwd: dir, stdio: 'ignore' });
  } catch {
    execFileSync('python3', ['-c', ZIP_PY, outPath], { cwd: dir, stdio: 'ignore' });
  }
}

function listZip(pkg) {
  try {
    return execFileSync('python3', ['-c', LIST_PY, pkg], { encoding: 'utf8' });
  } catch (e) {
    problems.push(`${pkg}: cannot list package (${e.message})`);
    return '';
  }
}

// ------------------------------------------------------------ shared sources

// Files every target needs, straight from the repo root.
const sharedFiles = ['background.js', 'content.js', 'shortcuts.js', 'options.html', 'options.js'];
const sharedDirs = ['icons', '_locales'];

// ------------------------------------------------------------ target matrix

// Overlay files copied from platform/<target>/ into build/<target>/,
// overriding the shared copy. The manifest is handled separately (version
// injection) but listed here for the completeness check.
const targets = {
  chrome: {
    manifest: null, // root manifest.json IS the chrome manifest
    overlay: [],
  },
  firefox: {
    manifest: 'platform/firefox/manifest.json',
    overlay: [],
  },
  thunderbird: {
    manifest: 'platform/thunderbird/manifest.json',
    overlay: ['background.js', 'popup.html', 'popup.js'],
  },
};

// ------------------------------------------------------------------- checks

function validate() {
  const rootManifest = readJson(path.join(repoDir, 'manifest.json'));
  const version = rootManifest.version;

  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version || '')) {
    problems.push(`manifest.json version '${version}' is not in x.y.z format`);
  }

  // JS syntax — same check the release workflow enforces.
  for (const f of sharedFiles.filter((f) => f.endsWith('.js'))) {
    try {
      execFileSync('node', ['--check', path.join(repoDir, f)], { stdio: 'ignore' });
    } catch {
      problems.push(`${f}: node --check failed`);
    }
  }
  for (const name of Object.keys(targets)) {
    for (const f of targets[name].overlay.filter((f) => f.endsWith('.js'))) {
      try {
        execFileSync('node', ['--check', path.join(repoDir, 'platform', name, f)],
          { stdio: 'ignore' });
      } catch {
        problems.push(`platform/${name}/${f}: node --check failed`);
      }
    }
  }

  // Locale key parity (de/en) — the same check the release workflow enforces.
  const de = readJson(path.join(repoDir, '_locales', 'de', 'messages.json'));
  const en = readJson(path.join(repoDir, '_locales', 'en', 'messages.json'));
  const deKeys = Object.keys(de).sort().join(',');
  const enKeys = Object.keys(en).sort().join(',');
  if (deKeys !== enKeys) {
    problems.push('_locales de/en key sets differ');
  }

  // Message placeholders must be defined. Chrome refuses to load the WHOLE
  // extension when a message uses $TOKEN$ without a matching `placeholders`
  // entry ("Variable $COUNT$ used but not defined" — found at v1.6.2 after
  // v1.6.0/v1.6.1 were rejected by the Web Store for broken functionality).
  // `$$` is an escaped literal dollar sign and must not be flagged.
  for (const [lang, dict] of [['de', de], ['en', en]]) {
    for (const [key, entry] of Object.entries(dict)) {
      const msg = typeof entry === 'object' && entry !== null ? entry.message : entry;
      if (typeof msg !== 'string') continue;
      const declared = new Set(
        Object.keys((entry && entry.placeholders) || {}).map((p) => p.toLowerCase())
      );
      const stripped = msg.replace(/\$\$/g, '\u0000');
      for (const m of stripped.matchAll(/\$([A-Za-z0-9_]+)\$/g)) {
        if (!declared.has(m[1].toLowerCase())) {
          problems.push(
            `_locales/${lang}/messages.json: '${key}' uses $${m[1]}$ but defines no such placeholder`
          );
        }
      }
    }
  }

  // Overlay files must exist.
  for (const name of Object.keys(targets)) {
    const t = targets[name];
    for (const f of t.overlay) {
      if (!fs.existsSync(path.join(repoDir, 'platform', name, f))) {
        problems.push(`platform/${name}/${f} missing`);
      }
    }
    if (t.manifest && !fs.existsSync(path.join(repoDir, t.manifest))) {
      problems.push(`${t.manifest} missing`);
    }
  }
  return version;
}

// -------------------------------------------------------------------- build

function buildTarget(name, version) {
  const t = targets[name];
  const out = path.join(buildDir, name);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  // shared sources
  for (const f of sharedFiles) copyFile(path.join(repoDir, f), path.join(out, f));
  for (const d of sharedDirs) copyDir(path.join(repoDir, d), path.join(out, d));

  // overlay (thunderbird: background/popup replace the shared copies)
  for (const f of t.overlay) {
    copyFile(path.join(repoDir, 'platform', name, f), path.join(out, f));
  }

  // manifest: root manifest for chrome, overlay manifest with the root
  // version injected for the others.
  let manifest;
  if (t.manifest === null) {
    manifest = readJson(path.join(repoDir, 'manifest.json'));
  } else {
    manifest = readJson(path.join(repoDir, t.manifest));
    manifest.version = version;
  }
  fs.writeFileSync(path.join(out, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n');

  console.log(`built build/${name} (v${version})`);
}

function packageTarget(name, version) {
  const out = path.join(buildDir, name);
  const ext = name === 'thunderbird' ? 'xpi' : 'zip';
  const pkg = path.join(distDir, `${version}-${name}.${ext}`);
  fs.mkdirSync(distDir, { recursive: true });
  fs.rmSync(pkg, { force: true });
  zipDirectory(out, pkg);

  // Verify the package carries the manifest and (TB) the popup.
  const listing = listZip(pkg);
  if (!/^manifest\.json$/m.test(listing)) {
    problems.push(`${pkg}: manifest.json missing from package`);
  }
  if (name === 'thunderbird' && !/^popup\.html$/m.test(listing)) {
    problems.push(`${pkg}: popup.html missing from thunderbird package`);
  }
  console.log(`packaged ${path.relative(repoDir, pkg)}`);
}

// --------------------------------------------------------------------- main

const args = process.argv.slice(2);
const doZip = !args.includes('--no-zip');
const wanted = args.filter((a) => !a.startsWith('--'));

const version = validate();

if (problems.length) {
  console.error('BUILD FAILED:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

const names = wanted.filter((n) => {
  if (!targets[n]) { console.error(`unknown target: ${n}`); process.exit(1); }
  return true;
});
const buildNames = names.length ? names : Object.keys(targets);

for (const n of buildNames) {
  buildTarget(n, version);
  if (doZip) packageTarget(n, version);
}

console.log(`\nOK — version ${version}, targets: ${buildNames.join(', ')}`);