// Restores Postgres/MySQL dumps into a throwaway container with networking disabled, then counts rows.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { maskError } from './index.js';

export const IMAGES = { postgres: 'postgres:17-alpine', mysql: 'mysql:8.4' };
const MAX_TABLES = 500;

const docker = (args, { timeout = 120000, input } = {}) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout, input, windowsHide: true });
  if (r.error?.code === 'ENOENT') throw new Error('Docker is not installed or not on PATH');
  return r;
};

export function dockerAvailable() {
  try { return docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 20000 }).status === 0; } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// engine: 'postgres' | 'mysql'; format: 'sql' | 'custom'
export async function restoreInDocker(file, { engine, format, gzip, image, timeoutSec = 600, onCleanup }) {
  const name = `dumpproof-${randomBytes(6).toString('hex')}`;
  const pw = randomBytes(18).toString('base64url');
  const img = image ?? IMAGES[engine];
  const env = engine === 'postgres'
    ? ['-e', `POSTGRES_PASSWORD=${pw}`, '-e', 'POSTGRES_DB=restore']
    : ['-e', `MYSQL_ROOT_PASSWORD=${pw}`, '-e', 'MYSQL_DATABASE=restore'];
  const cleanup = () => docker(['rm', '-f', '-v', name], { timeout: 60000 });
  onCleanup?.(cleanup);
  const started = Date.now();
  try {
    // --network none: whatever is inside the dump cannot reach the network.
    const run = docker(['run', '-d', '--rm', '--network', 'none', '--name', name, ...env, img], { timeout: 600000 });
    if (run.status !== 0) return { error: `could not start ${img}: ${maskError((run.stderr || '').trim().split('\n').pop())}` };

    // Ready = accepts TCP on 127.0.0.1 (the images' init phase only listens on a socket).
    const ready = engine === 'postgres'
      ? ['pg_isready', '-h', '127.0.0.1', '-U', 'postgres']
      : ['mysql', '--protocol=TCP', '-h127.0.0.1', '-uroot', '-e', 'SELECT 1'];
    const execEnv = engine === 'postgres' ? ['-e', `PGPASSWORD=${pw}`] : ['-e', `MYSQL_PWD=${pw}`];
    let ok = false;
    for (let i = 0; i < 120 && !ok; i++) { ok = docker(['exec', ...execEnv, name, ...ready], { timeout: 20000 }).status === 0; if (!ok) await sleep(1000); }
    if (!ok) return { error: `${img} did not become ready in 2 minutes` };

    const cp = docker(['cp', file, `${name}:/dump`], { timeout: 600000 });
    if (cp.status !== 0) return { error: `could not copy the dump into the container: ${maskError(cp.stderr.trim())}` };

    const cat = gzip ? 'gunzip -c /dump' : 'cat /dump';
    let cmd;
    if (engine === 'postgres' && format === 'custom') {
      cmd = gzip ? 'gunzip -c /dump > /dump.pg && pg_restore --no-owner --no-privileges -U postgres -h 127.0.0.1 -d restore /dump.pg'
        : 'pg_restore --no-owner --no-privileges -U postgres -h 127.0.0.1 -d restore /dump';
    } else if (engine === 'postgres') cmd = `${cat} | psql -q -U postgres -h 127.0.0.1 -d restore`;
    else cmd = `${cat} | mysql --protocol=TCP -h127.0.0.1 -uroot restore`;
    const t0 = Date.now();
    const res = docker(['exec', ...execEnv, name, 'sh', '-c', `${cmd} 2>&1 >/dev/null`], { timeout: timeoutSec * 1000 });
    const restoreSec = (Date.now() - t0) / 1000;
    if (res.error?.code === 'ETIMEDOUT') return { error: `restore took longer than ${timeoutSec}s (--timeout)` };

    const lines = (res.stdout || '').split('\n').filter((l) => /ERROR|FATAL|error:/i.test(l));
    // Plain SQL dumps reference roles that only exist on the original server: not a backup problem.
    const roleErrors = lines.filter((l) => /role "[^"]*" does not exist/.test(l));
    const errors = lines.filter((l) => !roleErrors.includes(l)).map(maskError);
    const failed = engine === 'mysql' || format === 'custom' ? res.status !== 0 : errors.length > 0;

    const tables = failed ? [] : countRows(engine, name, execEnv);
    return { image: img, restoreSec, totalSec: (Date.now() - started) / 1000, failed, errors: errors.slice(0, 5), errorCount: errors.length, ignoredRoleErrors: roleErrors.length, tables };
  } finally {
    cleanup();
  }
}

function query(engine, name, execEnv, sql) {
  const args = engine === 'postgres'
    ? ['exec', ...execEnv, name, 'psql', '-U', 'postgres', '-h', '127.0.0.1', '-d', 'restore', '-At', '-F', '\t', '-c', sql]
    : ['exec', ...execEnv, name, 'mysql', '--protocol=TCP', '-h127.0.0.1', '-uroot', '-N', '-B', '-e', sql];
  const r = docker(args, { timeout: 600000 });
  if (r.status !== 0) throw new Error(maskError(r.stderr.trim().split('\n')[0] || 'query failed'));
  return r.stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));
}

const unescapeMysql = (s) => s.replace(/\\([\\0tn])/g, (_, c) => ({ '\\': '\\', 0: '\0', t: '\t', n: '\n' })[c]);

function countRows(engine, name, execEnv) {
  let list;
  if (engine === 'postgres') {
    list = query(engine, name, execEnv, `SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2 LIMIT ${MAX_TABLES}`);
  } else {
    list = query(engine, name, execEnv, `SELECT table_schema, table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema') ORDER BY 1, 2 LIMIT ${MAX_TABLES}`).map((r) => r.map(unescapeMysql));
  }
  if (!list.length) return [];
  // Identifiers come from the dump: always quoted, so a table name can't inject SQL.
  const q = engine === 'postgres' ? (s) => `"${s.replace(/"/g, '""')}"` : (s) => `\`${s.replace(/`/g, '``')}\``;
  const counts = new Map();
  for (let i = 0; i < list.length; i += 100) {
    const sql = list.slice(i, i + 100).map(([s, t], j) => `SELECT ${i + j}, count(*) FROM ${q(s)}.${q(t)}`).join(' UNION ALL ');
    for (const [idx, c] of query(engine, name, execEnv, sql)) counts.set(Number(idx), Number(c));
  }
  return list.map(([s, t], i) => ({ name: engine === 'postgres' && s === 'public' ? t : `${s}.${t}`, rows: counts.get(i) ?? 0 }));
}
