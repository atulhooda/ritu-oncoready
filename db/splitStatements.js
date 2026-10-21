// ═══════════════════════════════════════════════════════════════════════════
// SPLIT A MIGRATION FILE INTO STANDALONE STATEMENTS
//
// WHY THIS EXISTS. db/migrate.js sends each file as ONE client.query(sql), and
// Postgres wraps a multi-statement simple query in an IMPLICIT transaction. So
// CREATE INDEX CONCURRENTLY raises 25001 no matter what the runner does — the
// @no-transaction directive only skips the runner's OWN BEGIN/COMMIT and cannot
// escape the implicit one.
//
// PROVEN 2026-08-13 against a virgin Postgres 16 in Docker, the first time this
// repo has ever run its migrations on an empty database:
//
//     → applying 005_booking_integrity… (no transaction — see the directive)
//     ✗ 005_booking_integrity failed: CREATE INDEX CONCURRENTLY cannot run
//       inside a transaction block
//
// 005 has been shipped as "apply it by hand with tools/applyMigration.js, then
// commit it so the runner skips it". That works for the clinics already
// migrated. It does NOT work for a NEW one — and one deploy + one database per
// clinic is the architecture. A new clinic crash-loops on first boot unless
// somebody remembers a manual step. The same false belief — that
// @no-transaction makes CONCURRENTLY safe — is what put CONCURRENTLY into
// migration 009 and crash-looped production on 2026-08-10.
//
// Splitting the file and sending each statement on its own is what
// applyMigration.js already does by hand. This makes it the runner's job.
//
// WHY NOT THE EXISTING SPLITTER. tools/applyMigration.js:56 strips `--` lines
// and splits on every `;`. MEASURED on migration 009, which uses a DO block:
//
//     [0] ALTER TABLE patient_medications ADD COLUMN …
//     [1] DO $$ BEGIN IF NOT EXISTS ( SELECT 1 FROM pg_constraint …
//     [2] END IF                       <- fragment
//     [3] END $$                       <- fragment
//     [4] CREATE INDEX IF NOT EXISTS …
//
// Three broken pieces out of one statement. A semicolon inside a dollar-quoted
// body, a string literal, or a comment is not a statement boundary, and a
// splitter that thinks it is will corrupt the next migration somebody writes.
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

/**
 * Split SQL into executable statements, respecting the four places a semicolon
 * is NOT a boundary: line comments, block comments, single-quoted strings, and
 * dollar-quoted bodies ($$ … $$ or $tag$ … $tag$).
 *
 * Comments are preserved inside the statements they precede — Postgres does not
 * mind, and stripping them makes an error message point at unrecognisable SQL.
 *
 * @param {string} sql
 * @returns {string[]} statements, trimmed, without trailing semicolons, empties dropped
 */
function splitStatements(sql) {
  const src = String(sql || '');
  const out = [];
  let buf = '';
  let i = 0;

  while (i < src.length) {
    const c = src[i];
    const rest = src.slice(i);

    // -- line comment: runs to end of line
    if (c === '-' && src[i + 1] === '-') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl + 1;
      buf += src.slice(i, end);
      i = end;
      continue;
    }

    // /* block comment */ — Postgres nests these, so track depth
    if (c === '/' && src[i + 1] === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; continue; }
        if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; continue; }
        j++;
      }
      buf += src.slice(i, j);
      i = j;
      continue;
    }

    // 'single-quoted string', where '' is an escaped quote
    if (c === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "'" && src[j + 1] === "'") { j += 2; continue; }
        if (src[j] === "'") { j++; break; }
        j++;
      }
      buf += src.slice(i, j);
      i = j;
      continue;
    }

    // "quoted identifier"
    if (c === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '"' && src[j + 1] === '"') { j += 2; continue; }
        if (src[j] === '"') { j++; break; }
        j++;
      }
      buf += src.slice(i, j);
      i = j;
      continue;
    }

    // $$ … $$ or $tag$ … $tag$ — the one the old splitter got wrong.
    // A tag is letters/digits/underscore, so `$1` placeholders are NOT tags and
    // must fall through to ordinary text.
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const close = src.indexOf(tag, i + tag.length);
      const end = close === -1 ? src.length : close + tag.length;
      buf += src.slice(i, end);
      i = end;
      continue;
    }

    // a real boundary
    if (c === ';') {
      out.push(buf);
      buf = '';
      i++;
      continue;
    }

    buf += c;
    i++;
  }
  out.push(buf);

  // A "statement" of nothing but comments and whitespace is not a statement —
  // sending it to Postgres draws an empty-query error.
  return out
    .map((s) => s.trim())
    .filter((s) => s && stripComments(s).trim().length > 0);
}

// Only used to decide whether a chunk is comment-only. Not used to build the
// SQL that actually runs — that keeps its comments.
function stripComments(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');
}

module.exports = { splitStatements };
