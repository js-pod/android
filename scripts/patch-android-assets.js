#!/usr/bin/env node
// Two Android-specific patches that prep node_modules before AAPT picks
// up the assets:
//   1. Rename any '_'-prefixed dirs and rewrite their refs — AAPT
//      silently filters them out of packaged assets and overriding
//      ignoreAssetsPattern didn't stick.
//   2. Rewrite Unicode property-escape regexes (\p{...} / \P{...})
//      to V8-compatible alternatives — nodejs-mobile's V8 build chokes
//      on them at module-load time with "Invalid property name".

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'nodejs-assets', 'nodejs-project', 'node_modules');
const UNDERSCORE_REPLACEMENT = 'und';

// --- (1) underscore-prefixed dirs ---

function findUnderscoreDirs(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.name.startsWith('_')) out.push(p);
    else findUnderscoreDirs(p, out);
  }
  return out;
}

function patchUnderscoreRefs(pkgRoot, oldName) {
  const oldFrag = `/${oldName}/`;
  const newFrag = `/${UNDERSCORE_REPLACEMENT}/`;
  let count = 0;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(js|mjs|cjs|ts)$/.test(e.name)) continue;
      const src = fs.readFileSync(p, 'utf8');
      if (!src.includes(oldFrag)) continue;
      fs.writeFileSync(p, src.split(oldFrag).join(newFrag));
      count++;
    }
  })(pkgRoot);
  return count;
}

const dirs = findUnderscoreDirs(ROOT);
for (const dir of dirs) {
  const parent = path.dirname(dir);
  const oldName = path.basename(dir);
  const newPath = path.join(parent, UNDERSCORE_REPLACEMENT);
  if (fs.existsSync(newPath)) {
    console.error(`patch-android-assets: ${newPath} already exists; skipping ${dir}`);
    continue;
  }
  fs.renameSync(dir, newPath);
  let pkgRoot = dir;
  while (pkgRoot.length > ROOT.length && !fs.existsSync(path.join(pkgRoot, 'package.json'))) {
    pkgRoot = path.dirname(pkgRoot);
  }
  const n = patchUnderscoreRefs(pkgRoot, oldName);
  console.log(`patch-android-assets: ${dir} -> ${newPath} (${n} files patched)`);
}

// --- (2) Unicode property escapes ---

// Rough ASCII-only fallbacks for the property classes we've seen in deps.
// They're not Unicode-correct — but the call sites use them for input
// sanitization / identifier matching, where ASCII coverage is enough to
// boot. Revisit if a real localized input slips through.
//
// Two replacements per property: the "class" form (bare members, for use
// inside an existing [...] character class) and the "standalone" form
// (already wrapped in []). Context detection below picks the right one.
const PROPERTY_REPLACEMENTS = [
  { name: 'ID_Start',    class: 'A-Za-z_$',     standalone: '[A-Za-z_$]' },
  { name: 'ID_Continue', class: 'A-Za-z0-9_$',  standalone: '[A-Za-z0-9_$]' },
  { name: 'C',           class: '\\x00-\\x1f\\x7f-\\x9f',     standalone: '[^\\x00-\\x1f\\x7f-\\x9f]', invert: true },
  { name: 'L',           class: 'A-Za-z',       standalone: '[A-Za-z]' },
  { name: 'N',           class: '0-9',          standalone: '[0-9]' },
];

// Replace one property escape with the appropriate form. If the escape
// sits inside an existing [...] character class, use the bare "class"
// form (no extra brackets). Otherwise use the standalone form.
//   - `\p{Foo}` keeps the property's character set
//   - `\P{Foo}` is the complement
function replacePropertyEscape(src) {
  let out = '';
  let i = 0;
  let inClass = false;
  while (i < src.length) {
    const ch = src[i];
    // Property escape detection (must come BEFORE generic backslash eat):
    if (ch === '\\' && i + 2 < src.length && (src[i + 1] === 'p' || src[i + 1] === 'P') && src[i + 2] === '{') {
      const end = src.indexOf('}', i + 3);
      if (end !== -1) {
        const name = src.slice(i + 3, end);
        const rule = PROPERTY_REPLACEMENTS.find(r => r.name === name);
        if (rule) {
          const negate = (src[i + 1] === 'P') !== !!rule.invert;
          if (inClass) {
            out += negate ? `^${rule.class}` : rule.class;
          } else {
            out += negate ? rule.standalone.replace(/^\[/, '[^') : rule.standalone;
          }
          i = end + 1;
          continue;
        }
      }
    }
    // Generic escape inside a class: keep the `\X` pair intact (so \] and
    // \\ aren't misread). Outside a class, the backslash is part of a
    // wider regex grammar that we don't try to parse — pass through.
    if (inClass && ch === '\\' && i + 1 < src.length) {
      out += ch + src[i + 1];
      i += 2;
      continue;
    }
    if (inClass && ch === ']') inClass = false;
    else if (!inClass && ch === '[') inClass = true;
    out += ch;
    i++;
  }
  return out;
}

function patchPropertyEscapesInFile(file) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { return false; }
  if (!src.includes('\\p{') && !src.includes('\\P{')) return false;
  const out = replacePropertyEscape(src);
  if (out === src) return false;
  fs.writeFileSync(file, out);
  return true;
}

function walkForRegexPatches(dir) {
  let count = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.bin') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { count += walkForRegexPatches(p); continue; }
    if (!/\.(js|mjs|cjs)$/.test(e.name)) continue;
    if (patchPropertyEscapesInFile(p)) count++;
  }
  return count;
}

if (fs.existsSync(ROOT)) {
  const n = walkForRegexPatches(ROOT);
  console.log(`patch-android-assets: rewrote Unicode property escapes in ${n} file(s)`);
}
