# dumpproof

[English](README.md) · Português · [日本語](README.ja.md)

Backup que nunca foi restaurado é um chute. O **dumpproof** restaura o backup num container descartável com a rede desligada, conta as linhas de todas as tabelas e diz se ele funciona de verdade. Depois apaga o container.

```bash
npx @guihakka2/dumpproof backup.sql.gz                    # dump PostgreSQL ou MySQL (precisa de Docker)
npx @guihakka2/dumpproof db.dump --require users,orders   # pg_dump -Fc, essas tabelas precisam ter linhas
npx @guihakka2/dumpproof app.sqlite                       # SQLite: integridade + contagem, sem Docker
npx @guihakka2/dumpproof volume-backup.tar.gz             # arquivo de volume Docker lido até o fim
```

- **PostgreSQL** (SQL puro ou `-Fc`) e **MySQL/MariaDB**: restaura em `postgres:17-alpine` / `mysql:8.4` (troque com `--image`).
- **SQLite**: `PRAGMA integrity_check` e contagem de linhas, só leitura (Node 22.13+).
- **tar / tar.gz**: confere o checksum de cada cabeçalho, os tamanhos, o gzip até o fim e caminhos perigosos (`../`).
- Erros de dono (`role "app" does not exist`) são esperados em outro servidor: são contados e ignorados. Qualquer outro erro falha.

Segurança: container com `--network none`, senha aleatória, sempre removido no final (inclusive com Ctrl+C). Os dados das linhas nunca aparecem, só nomes de tabelas e contagens. Detalhes em [SECURITY.md](SECURITY.md).
