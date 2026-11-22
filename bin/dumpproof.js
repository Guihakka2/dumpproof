#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { detect, inspectTar, inspectSqlite, printable } from '../src/index.js';
import { restoreInDocker, dockerAvailable } from '../src/docker.js';

const HELP = `Usage: dumpproof <backup-file> [options]

Proves a backup actually restores. Supports:
  PostgreSQL dumps (plain SQL or pg_dump -Fc), MySQL/MariaDB dumps: restored into a
  throwaway Docker container with networking disabled, then every table is counted.
  SQLite files: integrity check and row counts (no Docker, Node 22.13+).
  tar / tar.gz archives (e.g. Docker volume backups): every header, size and the
  gzip stream are checked to the end (no Docker).
Files ending in .gz are handled automatically. Data is never printed.

Options:
  --require LIST  Tables that must exist and have rows, comma-separated (e.g. users,orders)
  --min-rows N    Fail if the restored database has fewer rows in total
  --image IMG     Docker image to restore into (default postgres:17-alpine / mysql:8.4)
  --timeout SEC   Max restore time (default 600)
  --json          Machine-readable output
  -h, --help      Show help
  -v, --version   Show version

Exit codes: 0 = backup restores, 1 = backup is broken or a requirement failed, 2 = usage error or Docker missing`;

const OPTIONS = { require: { type: 'string' }, 'min-rows': { type: 'string' }, image: { type: 'string' }, timeout: { type: 'string' },
  json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' } };
const die = (msg) => { process.stderr.write(`dumpproof: ${printable(msg)}\n`); process.exit(2); };

let args;
try { args = parseArgs({ allowPositionals: true, options: OPTIONS }); } catch (e) {
  const bad = /'(--?[\w-]+)'/.exec(e.message)?.[1];
  const near = bad && Object.keys(OPTIONS).find((k) => bad.length > 3 && `--${k}`.startsWith(bad.slice(0, 4)));
  die(`${bad ? `unknown option ${bad}` : e.message}${near ? ` (did you mean --${near}?)` : ''}. See --help.`);
}
const { values: o, positionals } = args;
if (o.help) { console.log(HELP); process.exit(0); }
if (o.version) { console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version); process.exit(0); }
if (positionals.length !== 1) { console.log(HELP); process.exit(2); }
const num = (v, def, n) => { if (v === undefined) return def; const x = Number(v); if (!Number.isInteger(x) || x < 0) die(`${n} needs a whole number`); return x; };
const minRows = num(o['min-rows'], 0, '--min-rows');
const timeoutSec = num(o.timeout, 600, '--timeout') || 600;
if (o.image && !/^[\w.\-/:@]{1,200}$/.test(o.image)) die('invalid --image');
const required = (o.require ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const file = positionals[0];
let st;
try { st = statSync(file); } catch { die(`cannot read ${file}`); }
if (!st.isFile()) die(`${file} is not a file`);
const info = detect(file);

let cleanup;
const stop = () => { try { cleanup?.(); } finally { process.exit(130); } };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

const r = { file: printable(file), size: st.size, type: info.label, kind: info.kind };
if (info.kind === 'unknown') r.error = `cannot tell what kind of backup this is (${info.label})`;
else if (info.kind === 'tar') Object.assign(r, await inspectTar(file, info.gzip));
else if (info.kind === 'sqlite') Object.assign(r, await inspectSqlite(file, info.gzip));
else {
  if (!dockerAvailable()) die('Docker is needed to test-restore database dumps (is it installed and running?)');
  const engine = info.kind === 'mysql' ? 'mysql' : 'postgres';
  try {
    const d = await restoreInDocker(file, { engine, format: info.kind === 'postgres-custom' ? 'custom' : 'sql', gzip: info.gzip, image: o.image, timeoutSec, onCleanup: (f) => (cleanup = f) });
    Object.assign(r, d);
    if (d.failed) r.error = `restore failed with ${d.errorCount || 'an'} error${d.errorCount === 1 ? '' : 's'}`;
  } catch (e) { die(e.message); }
}

// Requirements only apply to databases.
const problems = [];
if (!r.error && r.tables) {
  const total = r.tables.reduce((s, t) => s + t.rows, 0);
  r.totalRows = total;
  if (!r.tables.length) problems.push('no tables in the backup');
  for (const t of required) {
    const hit = r.tables.find((x) => x.name === t || x.name.endsWith(`.${t}`));
    if (!hit) problems.push(`required table ${t} is missing`); else if (!hit.rows) problems.push(`required table ${t} is empty`);
  }
  if (total < minRows) problems.push(`only ${total} rows, expected at least ${minRows}`);
}
if (r.unsafe?.length) problems.push(`unsafe paths in archive: ${r.unsafe.join(', ')}`);
r.problems = problems;
r.ok = !r.error && !problems.length;

if (o.json) console.log(JSON.stringify(r, null, 2));
else {
  const color = (process.stdout.isTTY || !!process.env.FORCE_COLOR) && !process.env.NO_COLOR;
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const fmt = (n) => n.toLocaleString('en-US');
  const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
  console.log(`${c(1, 'dumpproof')}  ${r.file}  ${c(2, `(${r.type}, ${mb(r.size)})`)}`);
  if (r.image && !r.failed) console.log(`  ${c(32, '✓')} restored into ${r.image} in ${r.restoreSec.toFixed(1)}s ${c(2, '(network disabled)')}`);
  if (r.error) console.log(`  ${c(31, '✗')} ${printable(r.error)}`);
  for (const e of r.errors ?? []) console.log(`    ${c(31, printable(e))}`);
  if (r.errorCount > 5) console.log(c(2, `    … ${r.errorCount - 5} more`));
  if (r.kind === 'tar' && !r.error) console.log(`  ${c(32, '✓')} archive reads to the end: ${fmt(r.files)} files, ${fmt(r.dirs)} folders, ${mb(r.bytes)}`);
  if (r.tables && !r.error) {
    if (r.kind === 'sqlite') console.log(`  ${c(32, '✓')} integrity check passed`);
    console.log(`  ${fmt(r.tables.length)} tables · ${fmt(r.totalRows)} rows`);
    const w = Math.max(...r.tables.map((t) => printable(t.name).length), 5);
    for (const t of r.tables.slice(0, 30)) console.log(`    ${printable(t.name).padEnd(w)}  ${c(t.rows ? 0 : 33, fmt(t.rows).padStart(12))}`);
    if (r.tables.length > 30) console.log(c(2, `    … ${r.tables.length - 30} more (--json for all)`));
  }
  if (r.ignoredRoleErrors) console.log(c(2, `  ${r.ignoredRoleErrors} ownership statements skipped (roles from the original server)`));
  for (const p of problems) console.log(`  ${c(31, '✗')} ${printable(p)}`);
  console.log(r.ok ? c(32, '\nBackup is restorable.') : c(31, '\nBackup is NOT restorable as-is.'));
}
process.exit(r.ok ? 0 : 1);
