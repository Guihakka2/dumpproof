// dumpproof core: detect backup type and verify archives/SQLite files without Docker.
import { createReadStream, openSync, readSync, closeSync, mkdtempSync, createWriteStream, rmSync } from 'node:fs';
import { createGunzip, gunzipSync } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const printable = (s) => String(s).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '?');

function head(path, n = 65536) {
  const fd = openSync(path, 'r');
  try { const b = Buffer.alloc(n); return b.subarray(0, readSync(fd, b, 0, n, 0)); } finally { closeSync(fd); }
}

// Returns { kind, gzip, label } where kind is postgres-sql | postgres-custom | mysql | sqlite | tar | unknown.
export function detect(path) {
  let b = head(path);
  const gzip = b[0] === 0x1f && b[1] === 0x8b;
  if (gzip) { try { b = gunzipSync(b, { finishFlush: 2 }).subarray(0, 65536); } catch { return { kind: 'unknown', gzip, label: 'corrupt gzip' }; } }
  const text = b.toString('latin1');
  let kind = 'unknown';
  if (text.startsWith('PGDMP')) kind = 'postgres-custom';
  else if (text.startsWith('SQLite format 3\0')) kind = 'sqlite';
  else if (b.length > 262 && b.toString('latin1', 257, 262) === 'ustar') kind = 'tar';
  else if (/PostgreSQL database (cluster )?dump/.test(text)) kind = 'postgres-sql';
  else if (/(MySQL|MariaDB) dump/.test(text)) kind = 'mysql';
  const LABEL = { 'postgres-sql': 'PostgreSQL plain SQL dump', 'postgres-custom': 'PostgreSQL custom-format dump', mysql: 'MySQL/MariaDB dump', sqlite: 'SQLite database', tar: 'tar archive', unknown: 'unknown format' };
  return { kind, gzip, label: LABEL[kind] + (gzip ? ' (gzip)' : '') };
}

const octal = (buf) => {
  if (buf[0] & 0x80) { let n = 0; for (let i = 1; i < buf.length; i++) n = n * 256 + buf[i]; return n; } // base-256 for huge files
  return parseInt(buf.toString('latin1').replace(/\0.*$/s, '').trim() || '0', 8);
};

// Streams the whole archive: checks every header checksum, sizes, truncation and unsafe paths.
export async function inspectTar(path, gzip) {
  let pending = Buffer.alloc(0), skip = 0, zeros = 0, ended = false;
  const r = { files: 0, dirs: 0, bytes: 0, unsafe: [], error: null };
  const onHeader = (h) => {
    if (h.every((x) => x === 0)) { if (++zeros >= 2) ended = true; return; }
    zeros = 0;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h.subarray(148, 156))) throw new Error('bad header checksum (corrupt archive)');
    const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/s, '');
    const name = (prefix ? `${prefix}/` : '') + h.toString('utf8', 0, 100).replace(/\0.*$/s, '');
    const size = octal(h.subarray(124, 136));
    const type = String.fromCharCode(h[156] || 48);
    if (type === '0' || type === '7') { r.files++; r.bytes += size; } else if (type === '5') r.dirs++;
    if ((/^\/|^[A-Za-z]:|(^|\/)\.\.(\/|$)/.test(name)) && r.unsafe.length < 5) r.unsafe.push(printable(name));
    skip = type === '5' ? 0 : Math.ceil(size / 512) * 512;
  };
  const src = createReadStream(path);
  try {
    const consume = async (source) => {
      for await (const chunk of source) {
        if (ended) continue;
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        let off = 0;
        while (!ended) {
          if (skip) { const n = Math.min(skip, pending.length - off); skip -= n; off += n; if (skip) break; }
          if (pending.length - off < 512) break;
          onHeader(pending.subarray(off, off + 512));
          off += 512;
        }
        pending = pending.subarray(off);
      }
    };
    await (gzip ? pipeline(src, createGunzip(), consume) : pipeline(src, consume));
    if (!ended && (skip || pending.length)) r.error = 'archive is truncated (ends in the middle of a file)';
    else if (!ended && !r.files && !r.dirs) r.error = 'not a valid tar archive';
  } catch (e) {
    r.error = e.code === 'Z_BUF_ERROR' || /unexpected end/i.test(e.message) ? 'gzip stream is truncated' : e.message;
  }
  return r;
}

// SQLite: integrity check + row counts, read-only, in-process (Node 22.13+ has node:sqlite).
export async function inspectSqlite(path, gzip) {
  let mod;
  const warn = process.emitWarning;
  process.emitWarning = () => {}; // node:sqlite prints an ExperimentalWarning on some versions
  try { mod = await import('node:sqlite'); } catch { return { error: 'SQLite checks need Node 22.13 or newer' }; } finally { process.emitWarning = warn; }
  let file = path, tmp;
  if (gzip) {
    tmp = mkdtempSync(join(tmpdir(), 'dumpproof-'));
    file = join(tmp, 'db.sqlite');
    try { await pipeline(createReadStream(path), createGunzip(), createWriteStream(file)); } catch { rmSync(tmp, { recursive: true, force: true }); return { error: 'gzip stream is truncated' }; }
  }
  let db;
  try {
    db = new mod.DatabaseSync(file, { readOnly: true });
    const integrity = db.prepare('PRAGMA integrity_check').all().map((x) => Object.values(x)[0]);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 500").all().map((x) => x.name);
    const tables = names.map((n) => ({ name: n, rows: Number(db.prepare(`SELECT count(*) AS c FROM "${n.replace(/"/g, '""')}"`).get().c) }));
    return { tables, error: integrity[0] === 'ok' ? null : `integrity check failed: ${printable(integrity.slice(0, 3).join('; '))}` };
  } catch (e) {
    return { error: `not a readable SQLite database (${printable(e.message)})` };
  } finally {
    db?.close();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

// Database error messages can quote row values: keep the error, hide the data.
export function maskError(line) {
  return printable(line)
    .replace(/=\([^)]*\)/g, '=(…)')
    .replace(/'(?:[^'\\]|\\.){0,500}'/g, "'…'")
    .replace(/\bnear "[^"]*"/g, 'near "…"')
    .slice(0, 300);
}
