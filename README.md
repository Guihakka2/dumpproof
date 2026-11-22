# dumpproof

[![npm](https://img.shields.io/npm/v/@guihakka2/dumpproof)](https://www.npmjs.com/package/@guihakka2/dumpproof) [![CI](https://github.com/Guihakka2/dumpproof/actions/workflows/ci.yml/badge.svg)](https://github.com/Guihakka2/dumpproof/actions/workflows/ci.yml)

English · [Português](README.pt-BR.md) · [日本語](README.ja.md)

A backup you never restored is a guess. **dumpproof** restores it into a throwaway container with the network switched off, counts every table, and tells you if it actually works. Then it deletes the container.

```bash
npx @guihakka2/dumpproof backup.sql.gz                    # PostgreSQL or MySQL dump (needs Docker)
npx @guihakka2/dumpproof db.dump --require users,orders   # pg_dump -Fc, must contain rows in these tables
npx @guihakka2/dumpproof app.sqlite                       # SQLite: integrity check + counts, no Docker
npx @guihakka2/dumpproof volume-backup.tar.gz             # Docker volume archive read to the very end
```

```
$ dumpproof backup.sql.gz --require users,orders
dumpproof  backup.sql.gz  (PostgreSQL plain SQL dump (gzip), 286.2 KB)
  ✓ restored into postgres:17-alpine in 9.8s (network disabled)
  3 tables · 47,084 rows
    audit_log             0
    orders           45,880
    users             1,204
  2 ownership statements skipped (roles from the original server)

Backup is restorable.
```

## What it supports

| Backup | How it's checked | Needs |
|---|---|---|
| PostgreSQL plain SQL (`pg_dump`, `pg_dumpall`) | Restored with `psql` into `postgres:17-alpine` | Docker |
| PostgreSQL custom format (`pg_dump -Fc`) | Restored with `pg_restore --no-owner --no-privileges` | Docker |
| MySQL / MariaDB (`mysqldump`) | Restored with `mysql` into `mysql:8.4` | Docker |
| SQLite | `PRAGMA integrity_check` + row counts, read-only | Node 22.13+ |
| tar / tar.gz (volume backups) | Every header checksum and file size, gzip stream to the end, unsafe paths (`../`, absolute) | nothing |

`.gz` files are detected by content, not by name. Use `--image postgres:16-alpine` (or any tag) to match your server version.

**Ownership errors** (`role "app" does not exist`) are expected when a plain dump is restored on another server, so they are counted and skipped. Every other error fails the check.

## Use it in a cron or CI

```bash
pg_dump -Fc mydb > /backups/mydb.dump && npx -y @guihakka2/dumpproof /backups/mydb.dump --require users --min-rows 1000
```

Exit codes: `0` restorable, `1` broken backup or a requirement failed, `2` usage error or Docker missing.

## Options

| Option | |
|---|---|
| `--require LIST` | Tables that must exist and have rows (`users,orders`) |
| `--min-rows N` | Minimum total rows |
| `--image IMG` | Docker image to restore into |
| `--timeout SEC` | Max restore time (default 600) |
| `--json` | Machine-readable output |

## Security

See [SECURITY.md](SECURITY.md). Restores run in a container with `--network none` and a random password, which is always removed afterwards (also on Ctrl+C). Row data is never printed: only table names and counts, and error messages have their values masked.

## License

MIT · Part of [Guihakka Tools](https://github.com/Guihakka2/guihakka-tools)
