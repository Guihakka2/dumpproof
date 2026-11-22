# Security Policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting:
**Security tab > Report a vulnerability** on this repository.
You will get a reply within 7 days.

## Design guarantees

- Dumps are restored inside a throwaway Docker container started with `--network none`: anything inside the dump (functions, `\!` shell lines, `COPY ... PROGRAM`) runs isolated and cannot reach the network or your files.
- Each container gets a random name and a random database password, and is removed with its volumes when the check ends, fails or is interrupted.
- Docker is called with argument lists, never through a shell on your machine. Table names from the dump are always quoted when counting rows, so they cannot inject SQL.
- Row data is never printed: output has table names and counts only, and database error messages have quoted values and `Key (x)=(value)` details masked.
- SQLite files are opened read-only. tar archives are only read, never extracted; unsafe paths (`../`, absolute) are reported.
- No telemetry, zero runtime dependencies. npm releases are built by GitHub Actions with provenance; never by hand.

## Standalone executables

Release executables are built only by GitHub Actions (`binaries.yml`) from the tagged source with the official Node.js single executable application feature, smoke-tested, and published with a SHA256SUMS.txt and a build provenance attestation (`gh attestation verify <file> -R Guihakka2/dumpproof`). They are not code-signed with a paid certificate yet.
