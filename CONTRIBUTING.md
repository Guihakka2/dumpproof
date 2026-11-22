# Contributing

Thanks for helping! Rules that keep users safe:

1. Every change goes through a pull request reviewed by the maintainer.
2. **No new runtime dependencies** without an issue discussing it first.
3. Restores always run with `--network none`, and output never contains row data. Add a test if you touch either.
4. Run `npm test` before opening a PR (Node 20+). Docker tests run only where Docker is available (Linux CI).
5. A dump that fails but should pass? Add a minimal, anonymized version of it as a test.

English first for code, issues and docs. Translations (pt-BR, ja) are welcome as separate PRs.
