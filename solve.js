// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// run(input) returns exactly makefun-site 1.0.0's build(input): the output tree
// (path -> text) for one generated site, byte for byte. Same pipeline, same
// rules, same report lines — only faster: batched inline rendering, char-code
// block dispatch instead of per-line regexes, allocation-free word counting,
// reused for-loop scopes, and a fused lex+render Markdown pass.
//
// No state is kept between calls: every cache is created fresh inside run().

/* ------------------------------------------------------------------ text */

// HTML escape table, in README order: & < > " '
function escapeHtml(text) {
  const n = text.length;
  let out = null;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (out === null) out = text.slice(0, i);
      else out += text.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  if (out === null) return text;
  return out + text.slice(start);
}

const SLUG_MAX = 64;

function slugifyAscii(plain) {
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function slugify(text) {
  // Pure ASCII: NFKD is the identity and there are no combining marks.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) return slugifyAscii(text);
  // Non-ASCII: the reference algorithm exactly.
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/* ------------------------------------------------------------ front matter */

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const nx = raw[i + 1];
        if ((nx !== '"' && nx !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += nx;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function trimRightSpaces(s) {
  let e = s.length;
  while (e > 0) {
    const c = s.charCodeAt(e - 1);
    if (c === 32 || c === 9) e--;
    else break;
  }
  return s.slice(0, e);
}

function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    let j = 0;
    while (j < line.length) {
      const c = line.charCodeAt(j);
      if (c === 32 || c === 9) j++;
      else break;
    }
    if (j === line.length) continue; // blank
    if (line.charCodeAt(0) === 35) continue; // comment
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if ((c >= 97 && c <= 122) || c === 95) k++;
      else break;
    }
    if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = trimRightSpaces(line.slice(k + 2));
    else return { error: `line ${i + 1} is not "key: value"` };
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

/* --------------------------------------------------------------- markdown */

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

// First index >= from where `what` occurs outside a backslash escape, or -1.
// A match is skipped when preceded by an odd run of backslashes (the run's
// last backslash escapes the match's first character).
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let p = j;
    while (p > from && s.charCodeAt(p - 1) === 92) p--;
    if ((j - p) % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

// First single * from `from` (one whose next char is not *), outside an escape, or -1.
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let p = j;
    while (p > from && s.charCodeAt(p - 1) === 92) p--;
    if ((j - p) % 2 === 1) { j = s.indexOf('*', j + 1); continue; }
    if (s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

const LINK_WS = /\s/;

// Character kinds for the inline scanner: 0 plain, 1 backslash, 2 backtick,
// 3 star, 4 bracket, 5 HTML-special (& < > " ').
const KIND = new Uint8Array(128);
KIND[92] = 1;
KIND[96] = 2;
KIND[42] = 3;
KIND[91] = 4;
KIND[38] = 5;
KIND[60] = 5;
KIND[62] = 5;
KIND[34] = 5;
KIND[39] = 5;
const HTML_ENTITY = { 38: '&amp;', 60: '&lt;', 62: '&gt;', 34: '&quot;', 39: '&#39;' };
const HAS_SPECIAL = /[\\`*\[&<>"']/;

function inline(s, env) {
  // No structural or HTML-special character: the output is the input.
  if (!HAS_SPECIAL.test(s)) return s;
  const n = s.length;
  let out = '';
  let i = 0;
  let plain = 0; // start of the pending plain-text run (raw, unescaped)
  while (i < n) {
    const c = s.charCodeAt(i);
    const k = c < 128 ? KIND[c] : 0;
    if (k === 0) { i++; continue; }
    if (k === 5) { // HTML-special: flush the raw run, then the entity
      if (i > plain) out += s.slice(plain, i);
      out += HTML_ENTITY[c];
      i++;
      plain = i;
      continue;
    }
    if (k === 1) { // backslash
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        if (i > plain) out += s.slice(plain, i);
        out += escapeHtml(s[i + 1]);
        i += 2;
        plain = i;
      } else {
        i++; // literal backslash stays in the plain run
      }
      continue;
    }
    if (k === 2) { // backtick
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > plain) out += s.slice(plain, i);
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        plain = i;
      } else {
        i++; // literal backtick stays in the plain run
      }
      continue;
    }
    if (k === 3) { // *
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > plain) out += s.slice(plain, i);
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
          plain = i;
        } else {
          i += 2; // literal ** stays in the plain run
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > plain) out += s.slice(plain, i);
        out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
        i = j + 1;
        plain = i;
      } else {
        i++; // literal * stays in the plain run
      }
      continue;
    }
    // k === 4: [
    const kk = findUnescaped(s, ']', i + 1);
    const m = kk !== -1 && s.charCodeAt(kk + 1) === 40 ? s.indexOf(')', kk + 2) : -1;
    const target = m === -1 ? '' : s.slice(kk + 2, m);
    if (target !== '' && !LINK_WS.test(target)) {
      if (i > plain) out += s.slice(plain, i);
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, kk), env)}</a>`;
      i = m + 1;
      plain = i;
    } else {
      i++; // literal [ stays in the plain run
    }
  }
  if (n > plain) out += s.slice(plain, n);
  return out;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return line.slice(a, b);
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Fence open: ``` + optional lang [A-Za-z0-9_+-]* + spaces/tabs only. Returns lang or null.
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Heading: 1-6 # + space/tab + non-empty text. Returns {depth, text} or null.
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  if (d >= line.length) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let e = line.length;
  while (e > d) {
    const cc = line.charCodeAt(e - 1);
    if (cc === 32 || cc === 9) e--;
    else break;
  }
  let s = d;
  while (s < e) {
    const cc = line.charCodeAt(s);
    if (cc === 32 || cc === 9) s++;
    else break;
  }
  if (s >= e) return null;
  return { depth: d, text: line.slice(s, e) };
}

function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  const mark = c0 === 45 ? '---' : '***';
  if (!line.startsWith(mark)) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraph(line) {
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

// Bullet: "- " or "* " at the start. Returns the item text or null.
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return trimLine(line.slice(2));
  return null;
}

// Ordered: 1-9 digits + ". " at the start. Returns {start, text} or null.
function orderedOf(line) {
  const c0 = line.charCodeAt(0);
  if (c0 < 48 || c0 > 57) return null;
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { start: Number(line.slice(0, i)), text: trimLine(line.slice(i + 2)) };
}

// List continuation: 2+ spaces then a non-whitespace char.
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return WS[line.charCodeAt(i)] !== 1;
}

/** src rendered: HTML, table of contents, excerpt — same as the reference. */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const L = lines.length;
  while (i < L) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < L && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      let code = '';
      for (let k = 0; k < body.length; k++) code += `${escapeHtml(body[k])}\n`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) { // blockquote
      const body = [];
      while (i < L && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      let cur = null;
      while (i < L) {
        if (isOrdered) {
          const m = orderedOf(lines[i]);
          if (m !== null) { cur = [m.text]; items.push(cur); i++; continue; }
        } else {
          const m = bulletOf(lines[i]);
          if (m !== null) { cur = [m]; items.push(cur); i++; continue; }
        }
        if (cur !== null && isContinued(lines[i])) { cur.push(trimLine(lines[i])); i++; continue; }
        break;
      }
      const start = isOrdered ? ordered.start : 1;
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let lis = '';
      for (let k = 0; k < items.length; k++) lis += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${lis}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < L && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const html = inline(text, env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  let html = '';
  for (let k = 0; k < blocks.length; k++) html += `${blocks[k]}\n`;
  return { html, toc, excerpt: excerpt ?? '' };
}

/* --------------------------------------------------------------- templates */

const INCLUDE_DEPTH = 8;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += ctx.escape(textOf(lookup(scope, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope object and one loop object per execution of this for node,
        // mutated per iteration: rendering is synchronous and depth-first, so
        // no nested render can observe a stale binding.
        const child = { vars: {}, parent: scope };
        const loop = { index: 0, first: false, last: false, length: xs.length };
        child.vars.loop = loop;
        for (let k = 0; k < xs.length; k++) {
          child.vars[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          out += renderNodes(n.body, child, ctx, depth);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scope, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------- build */

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

function byCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isWhitespaceCode(c) {
  return WS[c] === 1;
}

// Whitespace table (JS \s set) — a constant, not case data.
const WS = new Uint8Array(65536);
for (const c of [32, 9, 10, 11, 12, 13, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]) WS[c] = 1;

function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  const templateNames = Object.keys(input.templates).sort(byCodeUnits);
  for (let ti = 0; ti < templateNames.length; ti++) {
    const name = templateNames[ti];
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. Sources, sorted by path in code-unit order; .md is a source, else static.
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (let fi = 0; fi < files.length; fi++) {
    const f = files[fi];
    if (f.path.endsWith('.md')) {
      b.sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: refused sources and drafts are reported and dropped.
  {
    const kept = [];
    for (let si = 0; si < b.sources.length; si++) {
      const s = b.sources[si];
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      let own = undefined;
      if (s.path.startsWith('tags/')) own = 'tags';
      else if (s.path.startsWith('page/')) own = 'page';
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. Permalinks: slug made unique in its directory, in source order.
  {
    const taken = new Map();
    for (let si = 0; si < b.sources.length; si++) {
      const s = b.sources[si];
      const dir = s.post ? 'posts' : dirOf(s.path);
      let set = taken.get(dir);
      if (set === undefined) {
        set = new Set(dir === '' ? RESERVED : []);
        taken.set(dir, set);
      }
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. Markdown, links resolved to the pages and static files they name.
  {
    const staticPaths = new Set();
    for (let fi = 0; fi < b.statics.length; fi++) staticPaths.add(b.statics[fi].path);
    for (let si = 0; si < b.sources.length; si++) {
      const s = b.sources[si];
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
          if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
          b.broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. Collections: posts newest first, then by slug; newer/older neighbours.
  {
    const posts = [];
    for (let si = 0; si < b.sources.length; si++) if (b.sources[si].post) posts.push(b.sources[si]);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    for (let k = 0; k < posts.length; k++) {
      posts[k].newer = k === 0 ? null : posts[k - 1];
      posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
    }
  }

  // 6. Tags, grouped by slug, ordered by count then slug.
  {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      const out = [];
      const names = s.data.tags ?? [];
      for (let k = 0; k < names.length; k++) {
        const slug = slugify(names[k]);
        if (!seen.has(slug)) { seen.add(slug); out.push(names[k]); }
      }
      return out;
    };
    for (let pi = 0; pi < b.posts.length; pi++) {
      const p = b.posts[pi];
      p.tagRefs = [];
      const names = ownTags(p);
      for (let k = 0; k < names.length; k++) {
        const name = names[k];
        const slug = slugify(name);
        let tag = bySlug.get(slug);
        if (tag === undefined) {
          tag = { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] };
          bySlug.set(slug, tag);
        }
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (let si = 0; si < b.sources.length; si++) {
      const s = b.sources[si];
      if (s.post) continue;
      const names = ownTags(s);
      s.tagRefs = [];
      for (let k = 0; k < names.length; k++) {
        const name = names[k];
        const slug = slugify(name);
        s.tagRefs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
      }
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  // 7. Layouts: every page through its layout, index and tag pages.
  {
    const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
    const cardOf = (s) => ({
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    });
    for (let pi = 0; pi < b.posts.length; pi++) b.cards.set(b.posts[pi], cardOf(b.posts[pi]));
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    const ctx = { templates: b.templates, escape: escapeHtml };
    const render = (name, vars) => {
      const nodes = b.templates.get(name);
      return nodes === undefined ? null : renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
    };
    for (let si = 0; si < b.sources.length; si++) {
      const s = b.sources[si];
      const card = s.post ? b.cards.get(s) : cardOf(s); // posts reuse the cached card
      const page = {
        title: card.title,
        url: card.url,
        date: card.date,
        date_long: card.date_long,
        summary: card.summary,
        excerpt: card.excerpt,
        reading_minutes: card.reading_minutes,
        tags: card.tags,
        slug: s.slug,
        content: s.html,
        toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: s.post,
      };
      b.output[`${s.outDir}/index.html`] = render(s.layout, { page });
    }
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (let ti = 0; ti < b.tags.length; ti++) {
      const t = b.tags[ti];
      const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) } });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (let fi = 0; fi < b.statics.length; fi++) {
      const f = b.statics[fi];
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. The report.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    let pages = 0;
    for (let si = 0; si < b.sources.length; si++) if (!b.sources[si].post) pages++;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }

  return b.output;
}
