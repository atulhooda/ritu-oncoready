#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// FIND EVERY OBJECT IN THE REPO THAT MAPS LANGUAGE CODES TO ANYTHING
//
// A REGISTRY WOULD NOT HAVE WORKED. The obvious design is "each module exports
// its spoken tables and the test iterates them" — but forgetting to register a
// new table is the SAME failure as forgetting to add a language to it, and that
// is the bug we are trying to make impossible. So this discovers tables by
// reading the source: a table nobody knew about is found anyway, and one added
// next month is found the day it is written.
//
// It reports DIRECT keys per object literal, not per file. That distinction is
// the whole point — a file-level count of callHandler.js says "11 languages"
// while MED_NAME_REASK inside it has 4, and sensitiveDataGuard.js does not even
// register as multilingual because it has only 2. Both readings were wrong on
// 2026-08-15 and both hid a live defect.
//
//     node tools/scanLanguageTables.js            # human-readable report
//     node tools/scanLanguageTables.js --json     # machine-readable
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs = require('fs');
const path = require('path');

const LANG_KEY = /^[a-z]{2}-IN$/;

// Single pass over the source, tracking what kind of text we are inside.
// Comments MUST be excluded rather than regex-stripped: this repo comments
// heavily and those comments contain braces ("{time}"), quotes ("table['hi-IN']")
// and language codes — all of which would corrupt brace depth or invent tables.
function scanSource(src) {
  const tables = [];
  const stack = [];           // one frame per open brace
  let depth = 0;
  let pendingName = null;     // identifier/key seen just before a '{'
  let lastSignificant = '';   // for the regex-literal heuristic

  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    // ── comments ──
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }

    // ── regex literal: a '/' in operand position, not division ──
    if (c === '/' && '(,=:[!&|?{};+-*%~^'.includes(lastSignificant)) {
      i++;
      let inClass = false;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        else if (src[i] === '/' && !inClass) { i++; break; }
        else if (src[i] === '\n') break;   // unterminated — was division after all
        i++;
      }
      lastSignificant = '/';
      continue;
    }

    // ── strings ──
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      let j = i + 1, val = '';
      while (j < n) {
        if (src[j] === '\\') { val += src[j + 1] || ''; j += 2; continue; }
        if (src[j] === quote) break;
        val += src[j]; j++;
      }
      // A language key is a quoted code followed by ':'.
      let k = j + 1;
      while (k < n && /\s/.test(src[k])) k++;
      if (LANG_KEY.test(val) && src[k] === ':') {
        if (stack.length) stack[stack.length - 1].langs.add(val);
      } else if (src[k] === ':') {
        pendingName = val;   // a quoted non-language key can still name a table
      }
      i = j + 1;
      lastSignificant = quote;
      continue;
    }

    // ── braces ──
    if (c === '{') {
      stack.push({ name: pendingName, langs: new Set(), depth });
      depth++; pendingName = null; i++; lastSignificant = '{';
      continue;
    }
    if (c === '}') {
      const frame = stack.pop();
      depth--;
      if (frame && frame.langs.size >= 2) {
        const names = stack.map((f) => f.name).filter(Boolean);
        tables.push({
          name: [...names, frame.name].filter(Boolean).join('.') || '(anonymous)',
          langs: [...frame.langs].sort(),
        });
      }
      i++; lastSignificant = '}';
      continue;
    }

    // ── identifiers, so `const FOO = {` and `foo: {` get a name ──
    if (/[A-Za-z_$]/.test(c)) {
      let j = i; while (j < n && /[\w$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      let k = j; while (k < n && /\s/.test(src[k])) k++;
      // Name the table only when this identifier is being assigned or keyed.
      if (src[k] === ':' || src[k] === '=') pendingName = word;
      i = j; lastSignificant = word[word.length - 1];
      continue;
    }

    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return tables;
}

function scanRepo(root) {
  const out = [];
  const skipDirs = new Set(['node_modules', '.git', 'tests', 'tools', 'coverage']);
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!skipDirs.has(e.name)) walk(path.join(dir, e.name)); continue; }
      if (!e.name.endsWith('.js')) continue;
      const file = path.join(dir, e.name);
      let src; try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const t of scanSource(src)) out.push({ file: path.relative(root, file), ...t });
    }
  };
  walk(root);
  return out;
}

module.exports = { scanSource, scanRepo };

if (require.main === module) {
  const root = path.join(__dirname, '..');
  const { SPOKEN_LANGUAGES } = require('../spokenLanguages');
  const found = scanRepo(root);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(found, null, 2));
  } else {
    console.log(`\n${found.length} language-keyed table(s)\n`);
    for (const t of found.sort((a, b) => a.langs.length - b.langs.length)) {
      const missing = SPOKEN_LANGUAGES.filter((l) => !t.langs.includes(l));
      const mark = missing.length ? '✗' : '✓';
      console.log(`  ${mark} ${String(t.langs.length).padStart(2)}/11  ${t.file}  ${t.name}`);
      if (missing.length) console.log(`          missing: ${missing.join(' ')}`);
    }
  }
}
