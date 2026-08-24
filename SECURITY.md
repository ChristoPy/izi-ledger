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
  a forged history, and plain `verify()` will pass. **Checkpoints are the answer
  to this.** `checkpoint()` returns a signed commitment to the ledger at a point
  in time; published somewhere the operators do not control, it cannot be
  reproduced by a later rewrite. Feed them back through `verify({ anchors })` or
  `izi-ledger audit`. Without published anchors, `verify()` proves only that the
  book is self-consistent — which is exactly what a careful forger produces.
- **Movement hashes are unsigned.** SHA-256 with no key proves *consistency*,
  not *authorship*. Checkpoints are where signing happens, and Ed25519 was
  chosen so that verification needs only the public half — a symmetric scheme
  (HMAC, or encryption at rest) cannot give a third party the ability to check
  without also giving it the ability to forge.
- **Encryption at rest does not help here.** It defends confidentiality against
  someone who lacks the key; every threat in this section involves someone who
  has it. Encrypt the volume if you want it — that is orthogonal, and does not
  cost you the choice of SQLite driver.
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
