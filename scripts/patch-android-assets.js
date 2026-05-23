#!/usr/bin/env node
// Android's AAPT silently filters directories whose names start with `_`
// from packaged assets, and we couldn't make ignoreAssetsPattern override
// stick. Rename any such dir inside node_modules and patch references so
// the bundle survives APK packaging.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'nodejs-assets', 'nodejs-project', 'node_modules');
const REPLACEMENT = 'und';

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

function patchFiles(pkgRoot, oldName) {
  const oldFrag = `/${oldName}/`;
  const newFrag = `/${REPLACEMENT}/`;
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
if (!dirs.length) {
  console.log('patch-android-assets: no underscore-prefixed dirs found');
  process.exit(0);
}

for (const dir of dirs) {
  const parent = path.dirname(dir);
  const oldName = path.basename(dir);
  const newPath = path.join(parent, REPLACEMENT);
  if (fs.existsSync(newPath)) {
    console.error(`patch-android-assets: ${newPath} already exists; skipping ${dir}`);
    continue;
  }
  fs.renameSync(dir, newPath);
  let pkgRoot = dir;
  while (pkgRoot.length > ROOT.length && !fs.existsSync(path.join(pkgRoot, 'package.json'))) {
    pkgRoot = path.dirname(pkgRoot);
  }
  const patched = patchFiles(pkgRoot, oldName);
  console.log(`patch-android-assets: ${dir} -> ${newPath} (${patched} files patched)`);
}
