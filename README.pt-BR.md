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

**Sem Node.js?** Cada [release](https://github.com/Guihakka2/dumpproof/releases/latest) tem um programa pronto para Windows, macOS e Linux (x64 e ARM): baixe, descompacte e rode `dumpproof` no terminal. A restauração de bancos continua precisando de Docker. Gerado pelo GitHub Actions, com `SHA256SUMS.txt` e atestado de procedência. Ainda sem assinatura paga: na primeira vez, o Windows mostra o SmartScreen ("Mais informações" → "Executar assim mesmo") e no macOS rode `xattr -d com.apple.quarantine dumpproof` uma vez.
