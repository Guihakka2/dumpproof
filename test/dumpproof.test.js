import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detect, inspectTar, inspectSqlite, maskError } from '../src/index.js';
import { dockerAvailable } from '../src/docker.js';

const BIN = new URL('../bin/dumpproof.js', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, timeout: 900000 });
const dir = mkdtempSync(join(tmpdir(), 'dumpproof-test-'));
const file = (name, content) => { const p = join(dir, name); writeFileSync(p, content); return p; };

// Minimal ustar writer for tests.
function tar(entries) {
  const blocks = [];
  for (const { name, data = '', type = '0' } of entries) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(Buffer.byteLength(data).toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136); h.write('        ', 148); h.write(type, 156); h.write('ustar\0' + '00', 257);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h);
    const d = Buffer.from(data); const pad = Buffer.alloc(Math.ceil(d.length / 512) * 512); d.copy(pad); blocks.push(pad);
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const PG_SQL = `--\n-- PostgreSQL database dump\n--\nCREATE TABLE public.users (id int primary key, email text);\nALTER TABLE public.users OWNER TO app_owner;\nINSERT INTO public.users VALUES (1, 'a@x.io'), (2, 'b@x.io');\nCREATE TABLE public."Weird ""name""" (x int);\n`;
const MYSQL = `-- MySQL dump 10.13  Distrib 8.4.0\nCREATE TABLE orders (id int primary key, total int);\nINSERT INTO orders VALUES (1, 10), (2, 20), (3, 30);\n`;

test('detect recognizes each backup type, gzip too', () => {
  assert.equal(detect(file('a.sql', PG_SQL)).kind, 'postgres-sql');
  assert.equal(detect(file('a.sql.gz', gzipSync(PG_SQL))).label, 'PostgreSQL plain SQL dump (gzip)');
  assert.equal(detect(file('b.dump', 'PGDMP\x01\x0e\x00')).kind, 'postgres-custom');
  assert.equal(detect(file('c.sql', MYSQL)).kind, 'mysql');
  assert.equal(detect(file('d.db', 'SQLite format 3\0' + '\0'.repeat(100))).kind, 'sqlite');
  assert.equal(detect(file('e.tar', tar([{ name: 'a.txt', data: 'hi' }]))).kind, 'tar');
  assert.equal(detect(file('f.bin', 'hello')).kind, 'unknown');
});

test('tar: full read, truncation, bad checksum, gzip truncation, unsafe paths', async () => {
  const good = tar([{ name: 'data/', type: '5' }, { name: 'data/a.txt', data: 'x'.repeat(1000) }, { name: 'data/b.txt', data: 'yy' }]);
  assert.deepEqual(await inspectTar(file('g.tar', good), false), { files: 2, dirs: 1, bytes: 1002, unsafe: [], error: null });
  assert.equal((await inspectTar(file('g.tar.gz', gzipSync(good)), true)).files, 2);
  assert.match((await inspectTar(file('t.tar', good.subarray(0, 1200)), false)).error, /truncated/);
  const bad = Buffer.from(good); bad[10] ^= 0xff;
  assert.match((await inspectTar(file('c.tar', bad), false)).error, /checksum/);
  const gz = gzipSync(good);
  assert.match((await inspectTar(file('tg.tar.gz', gz.subarray(0, gz.length - 20)), true)).error, /truncated/);
  assert.deepEqual((await inspectTar(file('u.tar', tar([{ name: '../etc/evil', data: 'x' }])), false)).unsafe, ['../etc/evil']);
});

test('sqlite: integrity and row counts, corrupt file', async (t) => {
  let mod;
  try { mod = await import('node:sqlite'); } catch { return t.skip('node:sqlite not available'); }
  const p = join(dir, 'app.db');
  const db = new mod.DatabaseSync(p);
  db.exec(`CREATE TABLE users (id INTEGER, email TEXT); INSERT INTO users VALUES (1, 'a'), (2, 'b'); CREATE TABLE "odd ""t""" (x);`);
  db.close();
  assert.deepEqual(await inspectSqlite(p, false), { tables: [{ name: 'odd "t"', rows: 0 }, { name: 'users', rows: 2 }], error: null });
  assert.equal((await inspectSqlite(file('app.db.gz', gzipSync(readFileSync(p))), true)).tables.length, 2);
  const broken = Buffer.from(readFileSync(p)); broken.fill(0x41, 200, 8000);
  assert.ok((await inspectSqlite(file('broken.db', broken), false)).error);
  const r = run([p, '--require', 'users', '--json']);
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).totalRows, 2);
  assert.equal(run([p, '--require', 'orders']).status, 1);
});

test('maskError hides row data', () => {
  assert.equal(maskError('ERROR:  duplicate key value violates unique constraint "u" DETAIL: Key (email)=(bob@x.com) already exists.'), 'ERROR:  duplicate key value violates unique constraint "u" DETAIL: Key (email)=(…) already exists.');
  assert.equal(maskError("ERROR 1062 (23000) at line 5: Duplicate entry 'bob@x.com' for key 'email'"), "ERROR 1062 (23000) at line 5: Duplicate entry '…' for key '…'");
});

test('CLI: tar ok/broken, unknown file, usage', () => {
  const ok = run([file('vol.tar.gz', gzipSync(tar([{ name: 'pgdata/PG_VERSION', data: '17' }])))]);
  assert.equal(ok.status, 0); assert.match(ok.stdout, /archive reads to the end: 1 files/);
  const g = gzipSync(tar([{ name: 'a', data: 'x'.repeat(5000) }]));
  const broken = run([file('cut.tar.gz', g.subarray(0, g.length - 30))]);
  assert.equal(broken.status, 1); assert.match(broken.stdout, /NOT restorable/);
  assert.equal(run([file('x.bin', 'nope')]).status, 1);
  assert.equal(run([]).status, 2);
  assert.equal(run([join(dir, 'missing.sql')]).status, 2);
  const typo = run(['x', '--requir', 'a']);
  assert.equal(typo.status, 2); assert.match(typo.stderr, /did you mean --require/);
});

// Real restores need Docker (Linux CI runners have it).
const docker = process.platform === 'linux' && dockerAvailable();
test('Docker: Postgres plain dump restores, role errors ignored, data never printed', { skip: !docker && 'Docker not available', timeout: 900000 }, () => {
  const r = run([file('pg.sql.gz', gzipSync(PG_SQL)), '--require', 'users']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /restored into postgres:17-alpine/);
  assert.match(r.stdout, /2 tables · 2 rows/);
  assert.match(r.stdout, /1 ownership statements skipped/);
  assert.doesNotMatch(r.stdout, /a@x\.io/);
  const bad = run([file('bad.sql', PG_SQL + "INSERT INTO public.users VALUES (1, 'dup@x.io');\nCREATE TABLE oops (;\n")]);
  assert.equal(bad.status, 1); assert.match(bad.stdout, /restore failed with 2 errors/);
  assert.doesNotMatch(bad.stdout, /dup@x\.io/);
});
test('Docker: MySQL dump restores', { skip: !docker && 'Docker not available', timeout: 900000 }, () => {
  const r = run([file('my.sql', MYSQL), '--min-rows', '3', '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.tables, [{ name: 'restore.orders', rows: 3 }]);
});
