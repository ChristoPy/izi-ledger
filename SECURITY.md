# Security

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
rather than opening a public issue.

## What this library does and does not protect against

`izi-ledger` gives you a **tamper-evident** ledger, not a tamper-proof one.
Every movement is hashed over its own fields plus the hash of the previous
movement in the ledger and the previous movement in its wallet, so `verify()`
detects edits made directly to the SQLite file — a rewritten amount, a deleted
row, a re-pointed hash, a doctored balance, a rewritten idempotency key.

What that means in practice:

- **Detection, not prevention.** Anyone who can write to the database file can
  change it. What they cannot do is change it and still have `verify()` pass.
- **The chain does not defend itself against a full rewrite.** An attacker with
  write access and the ability to run this library can recompute every hash from
  a forged history. If you need proof against that, anchor the head hash
  somewhere you control — `stats().headHash` is there for exactly that, and
  publishing it periodically turns a full rewrite into a detectable one.
- **No signing.** Hashes are SHA-256 with no key, so they prove *consistency*,
  not *authorship*.
- **File permissions are yours to set.** The library opens whatever path you
  give it with the process's own credentials.

## Operational notes

- Run `verify()` on a schedule, or `verifyOnOpen: true` on startup for books
  small enough that the walk is cheap.
- Keep `durability: 'full'` (the default) unless you have measured that you need
  `'normal'` and accept losing the last commits to a machine-level crash.
- The balance cache assumes the process can see every commit to the file. It
  does that by watching SQLite's `data_version`, which covers other processes on
  the same machine; a network filesystem where that guarantee does not hold is
  not a supported setup.
