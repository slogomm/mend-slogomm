// mend: applies an AI model's edit to a tree of text files (SPEC.md).
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 { constructor(line) { this.line = line; } }
class Fail { constructor(code, path) { this.code = code; this.path = path; } }

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

function splitLines(text: string): { lines: string[]; br: '\n' | '\r\n'; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const i = text.indexOf('\n');
  const br = i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinLines(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leading(s: string): string {
  const m = s.match(/^[ \t]*/);
  return m ? m[0] : '';
}
function rstrip(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimST(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function findOccurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = 0; i + oldLines.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      const a = lines[i + j]!;
      const b = oldLines[j]!;
      if (tier === 0) { if (a !== b) { ok = false; break; } }
      else if (tier === 1) { if (rstrip(a) !== rstrip(b)) { ok = false; break; } }
      else { if (trimST(a) !== trimST(b)) { ok = false; break; } }
    }
    if (ok) out.push(i);
  }
  return out;
}

function matchTier(lines: string[], oldLines: string[], strict: boolean): { tier: number; positions: number[] } {
  if (oldLines.length === 0) return { tier: 0, positions: [] };
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = findOccurrences(lines, oldLines, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return { tier: -1, positions: [] };
}

function transformN(nLines: string[], context: boolean[], tier: number, matched: string[], oldLines: string[], oldContext: boolean[]): string[] {
  const P = leading(oldLines[0] ?? '');
  const F = leading(matched[0] ?? '');
  let oi = 0;
  return nLines.map((line, i) => {
    if (context[i]) {
      while (oi < oldContext.length && !oldContext[oi]) oi++;
      const m = matched[oi];
      oi++;
      return m;
    }
    if (tier === 2 && line.trim() !== '' && line.startsWith(P)) return F + line.slice(P.length);
    return line;
  });
}

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const { lines, br, final } = splitLines(before);
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      const outLines = [...lines];
      outLines.splice(line, 0, ...add);
      tree.now.set(p, joinLines(outLines, br, final));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new Exit2(`error: parse ${first + 1}`); }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  for (let i = 0; i < lines.length; i++) {
    if (blank(lines[i]!)) continue;
    let e: Edit | null = null;
    try { e = jsonEdit(JSON.parse(lines[i]!)); } catch { e = null; }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  }
  return edits;
}

interface UnifiedHunk { a: number; body: string[]; noNewline: boolean; }
interface UnifiedSection {
  seenHunk: boolean;
  diffOld: string | null; diffNew: string | null;
  oldPath: string | null; newPath: string | null;
  renameFrom: string | null; renameTo: string | null;
  newFile: boolean; deleted: boolean; hunks: UnifiedHunk[];
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { seenHunk: false, diffOld: m[1]!, diffNew: m[2]!, oldPath: null, newPath: null, renameFrom: null, renameTo: null, newFile: false, deleted: false, hunks: [] };
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ') && (!cur || cur.seenHunk)) {
      cur = { seenHunk: false, diffOld: null, diffNew: null, oldPath: null, newPath: null, renameFrom: null, renameTo: null, newFile: false, deleted: false, hunks: [] };
      sections.push(cur);
      const oldp = lines[i]!.slice(4);
      const newp = lines[i + 1]!.slice(4);
      cur.oldPath = oldp.split('\t')[0]!.trim();
      cur.newPath = newp.split('\t')[0]!.trim();
      if (cur.oldPath.startsWith('a/')) cur.oldPath = cur.oldPath.slice(2);
      if (cur.newPath.startsWith('b/')) cur.newPath = cur.newPath.slice(2);
      i += 2;
      continue;
    }
    if (!cur) { i++; continue; }
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      const body: string[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
        if (b.startsWith('\\')) { body.push(b); i++; break; }
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+')) { body.push(b); i++; }
        else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      let noNewline = false;
      if (body.length >= 2 && body[body.length - 1]!.startsWith('\\')) {
        const prev = body[body.length - 2]!;
        if (prev.startsWith(' ') || prev.startsWith('+')) noNewline = true;
      }
      cur.hunks.push({ a: Number(m[1]), body, noNewline });
      cur.seenHunk = true;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (i + 1 >= n || !lines[i + 1]!.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
      const oldp = line.slice(4);
      const newp = lines[i + 1]!.slice(4);
      cur.oldPath = oldp.split('\t')[0]!.trim();
      cur.newPath = newp.split('\t')[0]!.trim();
      if (cur.oldPath.startsWith('a/')) cur.oldPath = cur.oldPath.slice(2);
      if (cur.newPath.startsWith('b/')) cur.newPath = cur.newPath.slice(2);
      i += 2;
      continue;
    }
    if (line.startsWith('+++ ') || line.startsWith('rename from ') || line.startsWith('rename to ') ||
        line.trim() === 'new file mode' || line.startsWith('new file mode ') ||
        line.trim() === 'deleted file mode' || line.startsWith('deleted file mode ') ||
        line.startsWith('index ') || line.startsWith('old mode ') || line.startsWith('new mode ') ||
        line.startsWith('similarity index ') || line.startsWith('dissimilarity index ') || line.startsWith('Index:')) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      if (line.trim() === 'new file mode' || line.startsWith('new file mode ')) cur.newFile = true;
      if (line.trim() === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.deleted = true;
      i++;
      continue;
    }
    i++;
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    let oldPath = s.oldPath;
    let newPath = s.newPath;
    if (oldPath === null && s.renameFrom !== null) oldPath = s.renameFrom;
    if (newPath === null && s.renameTo !== null) newPath = s.renameTo;
    if (oldPath === null && s.diffOld !== null) oldPath = s.diffOld;
    if (newPath === null && s.diffNew !== null) newPath = s.diffNew;
    if (oldPath === null) oldPath = '';
    if (newPath === null) newPath = '';
    const creation = oldPath === '/dev/null' || s.newFile;
    const deletion = newPath === '/dev/null' || s.deleted;
    const move = !creation && !deletion && oldPath !== newPath;
    edits.push((tree) => {
      if (!creation && !safe(oldPath)) throw new Fail('unsafe', oldPath);
      if ((creation || move) && !safe(newPath)) throw new Fail('unsafe', newPath);
      if (deletion) {
        if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
        tree.now.set(oldPath, null);
        return;
      }
      if (creation) {
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        const createdLines: string[] = [];
        let noNewline = false;
        let hasPlus = false;
        let lastPlusNoNewline = false;
        for (const h of s.hunks) {
          const n: string[] = [];
          let hunkHasPlus = false;
          for (const bl of h.body) {
            if (bl.startsWith(' ')) n.push(bl.slice(1));
            else if (bl === '') n.push('');
            else if (bl.startsWith('+')) { n.push(bl.slice(1)); hunkHasPlus = true; }
          }
          for (const line of n) createdLines.push(line);
          if (hunkHasPlus) { hasPlus = true; lastPlusNoNewline = h.noNewline; }
        }
        if (hasPlus) noNewline = lastPlusNoNewline;
        tree.now.set(newPath, createdLines.length === 0 ? '' : createdLines.join('\n') + (noNewline ? '' : '\n'));
        return;
      }
      const oldText = tree.get(oldPath);
      if (oldText === null) throw new Fail('missing', oldPath);
      if (move && tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const { lines: origLines, br, final: origFinal } = splitLines(oldText);
      let lines = [...origLines];
      let d = 0;
      let final = origFinal;
      for (const h of s.hunks) {
        const o: string[] = [];
        const n: string[] = [];
        const ctx: boolean[] = [];
        const oCtx: boolean[] = [];
        for (const bl of h.body) {
          if (bl.startsWith(' ')) { const t = bl.slice(1); o.push(t); n.push(t); ctx.push(true); oCtx.push(true); }
          else if (bl === '') { o.push(''); n.push(''); ctx.push(true); oCtx.push(true); }
          else if (bl.startsWith('-')) { o.push(bl.slice(1)); oCtx.push(false); }
          else if (bl.startsWith('+')) { n.push(bl.slice(1)); ctx.push(false); }
        }
        if (o.length === 0) {
          const idx = Math.min(h.a + d, lines.length);
          const reachesEnd = idx === lines.length;
          const out = transformN(n, ctx, 0, [], [], []);
          lines = lines.slice(0, idx).concat(out).concat(lines.slice(idx));
          d += out.length;
          if (reachesEnd) final = !h.noNewline;
        } else {
          const { tier, positions } = matchTier(lines, o, strict);
          if (tier < 0 || positions.length === 0) throw new Fail('no-match', oldPath);
          const target = h.a - 1 + d;
          let pos = positions[0]!;
          let best = Math.abs(pos - target);
          for (const p of positions) {
            const dist = Math.abs(p - target);
            if (dist < best || (dist === best && p < pos)) { pos = p; best = dist; }
          }
          const reachesEnd = pos + o.length === lines.length;
          const matched = lines.slice(pos, pos + o.length);
          const out = transformN(n, ctx, tier, matched, o, oCtx);
          lines = lines.slice(0, pos).concat(out).concat(lines.slice(pos + o.length));
          d += out.length - o.length;
          if (reachesEnd) final = !h.noNewline;
        }
      }
      const resultText = joinLines(lines, br, final);
      if (move) {
        if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
        tree.now.set(newPath, resultText);
        tree.now.set(oldPath, null);
        tree.moves.push({ old: oldPath, new: newPath });
      } else {
        tree.now.set(oldPath, resultText);
      }
    });
  }
  return edits;
}

interface SRBlock { path: string; oldLines: string[]; newLines: string[]; }

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevReplace = -1;
  let carryPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      let pathIndex = i - 1;
      while (pathIndex > prevReplace && (blank(lines[pathIndex]!) || lines[pathIndex]!.trim().startsWith('```'))) pathIndex--;
      let path: string;
      if (pathIndex <= prevReplace) {
        if (carryPath === null) throw new Exit2(`error: parse ${i + 1}`);
        path = carryPath;
      } else {
        path = lines[pathIndex]!.trim();
        carryPath = path;
      }
      let eq = -1;
      for (let j = i + 1; j < n; j++) if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
      if (eq < 0) throw new Exit2(`error: parse ${i + 1}`);
      let rep = -1;
      for (let j = eq + 1; j < n; j++) if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
      if (rep < 0) throw new Exit2(`error: parse ${i + 1}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevReplace = rep;
      i = rep + 1;
    } else {
      i++;
    }
  }
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSearchReplace(lines);
  const edits: Edit[] = [];
  for (const b of blocks) {
    const { path, oldLines, newLines } = b;
    edits.push((tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const { lines: fileLines, br, final } = splitLines(before);
      const { tier, positions } = matchTier(fileLines, oldLines, strict);
      if (tier < 0 || positions.length === 0) throw new Fail('no-match', path);
      if (positions.length > 1) throw new Fail('ambiguous', path);
      const pos = positions[0]!;
      const matched = fileLines.slice(pos, pos + oldLines.length);
      const out = transformN(newLines, new Array(newLines.length).fill(false), tier, matched, oldLines, []);
      const resultLines = fileLines.slice(0, pos).concat(out).concat(fileLines.slice(pos + oldLines.length));
      tree.now.set(path, joinLines(resultLines, br, final));
    });
  }
  return edits;
}

interface V4AChunk { anchor: string | null; eof: boolean; o: string[]; n: string[]; ctx: boolean[]; oCtx: boolean[]; }
interface V4ASection {
  type: 'add' | 'delete' | 'update';
  path: string;
  movePath: string | null;
  fileLines: string[];
  chunks: V4AChunk[];
}

function isSectionStart(line: string): boolean {
  return line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ') || line.startsWith('*** Update File: ');
}

function parseV4A(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = lines.length - 1 - [...lines].reverse().findIndex((l) => !blank(l));
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) { i++; continue; }
    if (lines[i]!.startsWith('*** Add File: ')) {
      const path = lines[i]!.slice(14).trim();
      i++;
      const raw: { text: string; lineNo: number }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) { raw.push({ text: lines[i]!, lineNo: i + 1 }); i++; }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text === '') fileLines.push('');
        else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else throw new Exit2(`error: parse ${r.lineNo}`);
      }
      sections.push({ type: 'add', path, movePath: null, fileLines, chunks: [] });
    } else if (lines[i]!.startsWith('*** Delete File: ')) {
      const path = lines[i]!.slice(17).trim();
      i++;
      const raw: { text: string; lineNo: number }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) { raw.push({ text: lines[i]!, lineNo: i + 1 }); i++; }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.lineNo}`);
      sections.push({ type: 'delete', path, movePath: null, fileLines: [], chunks: [] });
    } else if (lines[i]!.startsWith('*** Update File: ')) {
      const path = lines[i]!.slice(17).trim();
      const updateLine = i + 1;
      i++;
      let movePath: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        movePath = lines[i]!.slice(13).trim();
        i++;
      }
      const raw: { text: string; lineNo: number }[] = [];
      while (i < last && !isSectionStart(lines[i]!)) { raw.push({ text: lines[i]!, lineNo: i + 1 }); i++; }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      const chunks: V4AChunk[] = [];
      let idx = 0;
      const baseLine = raw.length > 0 ? raw[0]!.lineNo : updateLine + 1;
      while (idx < raw.length) {
        let anchor: string | null = null;
        if (raw[idx]!.text.startsWith('@@')) {
          anchor = raw[idx]!.text.slice(2).trim();
          idx++;
        } else if (chunks.length === 0) {
          anchor = null;
        } else {
          throw new Exit2(`error: parse ${raw[idx]!.lineNo}`);
        }
        const body: string[] = [];
        let eof = false;
        while (idx < raw.length) {
          if (raw[idx]!.text.startsWith('@@')) break;
          if (raw[idx]!.text === '*** End of File') { eof = true; idx++; break; }
          const t = raw[idx]!.text;
          if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
            body.push(t);
            idx++;
          } else {
            throw new Exit2(`error: parse ${raw[idx]!.lineNo}`);
          }
        }
        const o: string[] = [];
        const n: string[] = [];
        const ctx: boolean[] = [];
        const oCtx: boolean[] = [];
        for (const bl of body) {
          if (bl === '' || bl.startsWith(' ')) {
            const text = bl === '' ? '' : bl.slice(1);
            o.push(text); n.push(text); ctx.push(true); oCtx.push(true);
          } else if (bl.startsWith('-')) {
            o.push(bl.slice(1)); oCtx.push(false);
          } else if (bl.startsWith('+')) {
            n.push(bl.slice(1)); ctx.push(false);
          }
        }
        chunks.push({ anchor, eof, o, n, ctx, oCtx });
      }
      if (chunks.length === 0 && movePath === null) throw new Exit2(`error: parse ${updateLine}`);
      sections.push({ type: 'update', path, movePath, fileLines: [], chunks });
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return sections;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4A(lines);
  const edits: Edit[] = [];
  for (const sec of sections) {
    if (sec.type === 'add') {
      const path = sec.path;
      const fileLines = sec.fileLines;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (sec.type === 'delete') {
      const path = sec.path;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      const path = sec.path;
      const movePath = sec.movePath;
      const chunks = sec.chunks;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (movePath !== null && !safe(movePath)) throw new Fail('unsafe', movePath);
        const before = tree.get(path);
        if (before === null) throw new Fail('missing', path);
        if (movePath !== null && tree.get(movePath) !== null) throw new Fail('exists', movePath);
        const { lines: origLines, br, final: origFinal } = splitLines(before);
        let lines = [...origLines];
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null && ch.anchor !== '') {
            const found = findFirstAtOrAfter(lines, [ch.anchor], cursor, strict);
            if (found.pos < 0) throw new Fail('no-match', path);
            cursor = found.pos + 1;
          }
          if (ch.o.length > 0) {
            const tiers = strict ? [0] : [0, 1, 2];
            let foundTier = -1;
            let foundPos = -1;
            for (const tier of tiers) {
              const occ = findOccurrences(lines, ch.o, tier).filter((p) => p >= cursor);
              if (occ.length > 0) { foundTier = tier; foundPos = occ[0]!; break; }
            }
            if (foundTier < 0) throw new Fail('no-match', path);
            if (ch.eof && foundPos + ch.o.length !== lines.length) throw new Fail('no-match', path);
            const matched = lines.slice(foundPos, foundPos + ch.o.length);
            const out = transformN(ch.n, ch.ctx, foundTier, matched, ch.o, ch.oCtx);
            lines = lines.slice(0, foundPos).concat(out).concat(lines.slice(foundPos + ch.o.length));
            cursor = foundPos + out.length;
          } else {
            const insertAt = ch.eof ? lines.length : Math.min(cursor, lines.length);
            const out = transformN(ch.n, ch.ctx, 0, [], [], []);
            lines = lines.slice(0, insertAt).concat(out).concat(lines.slice(insertAt));
            cursor = insertAt + out.length;
          }
        }
        const resultText = joinLines(lines, br, origFinal);
        if (movePath !== null) {
          tree.now.set(movePath, resultText);
          tree.now.set(path, null);
          tree.moves.push({ old: path, new: movePath });
        } else {
          tree.now.set(path, resultText);
        }
      });
    }
  }
  return edits;
}

function findFirstAtOrAfter(lines: string[], oldLines: string[], cursor: number, strict: boolean): { tier: number; pos: number } {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const occ = findOccurrences(lines, oldLines, tier).filter((p) => p >= cursor);
    if (occ.length > 0) return { tier, pos: occ[0]! };
  }
  return { tier: -1, pos: -1 };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = [];
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moveNew = new Map<string, string>();
  const moveOld = new Set<string>();
  for (const m of tree.moves) {
    const oldExisted = tree.original(m.old) !== null;
    const newWasAbsent = tree.original(m.new) === null;
    const oldGone = tree.now.get(m.old) === null;
    const newPresent = tree.now.get(m.new) !== null;
    if (oldExisted && newWasAbsent && oldGone && newPresent) {
      moveNew.set(m.new, m.old);
      moveOld.add(m.old);
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveOld.has(p)) continue;
    if (moveNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [newPath, oldPath] of moveNew) {
    rows.push({ key: newPath, line: `R ${oldPath} -> ${newPath}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const outLines = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
