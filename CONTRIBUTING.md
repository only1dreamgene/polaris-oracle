# Contributing to polaris-oracle

This project follows an open contributor model: anyone is welcome to
contribute via peer review, testing, and patches. This document explains
the practical process, adapted from
[Bitcoin Core's CONTRIBUTING.md](https://github.com/bitcoin/bitcoin/blob/master/CONTRIBUTING.md)
— a small NestJS backend doesn't need everything a project the size of
Bitcoin Core does (no mailing list, no BIP process, no release branches to
backport into), but the underlying discipline — patches are small and
focused, reviewers actually test what they review, funds-critical code
gets a higher bar — applies here just as much as it does there.

There is no privileged "polaris-oracle developers" class. In practice
there's currently one maintainer reviewing and merging; that will change
as the project grows, and this document describes the process either way.

## Getting started

New contributors are welcome. **In-depth reviewing and testing is the
most effective way to start** — it teaches you the codebase faster than
writing a PR blind, and it's usually the bottleneck on a small project
like this one. See [Peer review](#peer-review) below.

Every open issue in this repo is written as a real problem found in the
shipped system — read the README's ["Bugs found by pressure-testing this
system"](./README.md#bugs-found-by-pressure-testing-this-system) section
first. It's fifteen entries of "this looked fine in a code read and only
broke under real use" — that's the bar an issue here is held to, and the
bar a fix is expected to meet: a regression test that's confirmed to fail
against the old code and pass against the fix, not just a green run.

Before contributing, install and run the test suite (see the README's
["Running locally"](./README.md#running-locally) section):

```sh
npm install
npm test          # 130 unit tests
npm run lint
```

## Communication

Discussion happens in GitHub issues and pull requests. There's no
separate chat/mailing list for a project this size — if you want early
feedback on an approach before writing code, open a draft PR or comment
on the issue.

## Contributor workflow

1. Fork the repository (first time only).
2. Create a topic branch.
3. Commit patches.
4. Push to your fork and open a pull request.

### Committing patches

Commits should be atomic and diffs easy to read — don't mix formatting
fixes with actual logic changes. Each commit should build, lint clean,
and pass `npm test` on its own, not just at the tip of the branch.

Commit messages should explain *why*, not just *what* — this codebase's
own bug log is full of "found live because X, fixed by Y" explanations;
match that standard. Reference the issue a commit addresses (`fixes #7`,
`refs #7`).

### Creating the pull request

Prefix the PR title with the area it touches:

- `market` — classic-market lifecycle (`market.*`, `market-factory.*`)
- `perpetual` — the perpetual-contract integration (`perpetual.*`)
- `wallet` — passkey/sponsored-relay code (`auth-relay.*`, `wire-args.*`, `wallet.*`)
- `email` — custodial email-login auth (`email-auth.*`)
- `admin` — the admin dashboard API (`admin.*`)
- `oracle` — `oracle.service.ts`, `pyth-price.ts`, `stellar.service.ts`'s oracle-reading code
- `docs` — README/comment-only changes
- `test` — test-only changes
- `ci`/`deploy` — workflow, Dockerfile, or Fly config changes

Example: `perpetual: schedule automatic checkpoints`

The PR description should explain what the patch does and, more
importantly, *why* — what problem it fixes, and how you tested it (which
new/existing tests cover it, or what you ran manually against a live
deployment). If there's reasonable doubt that you understand your own
change or tested it at a basic level, expect the PR to be closed rather
than reviewed at length — this isn't punitive, it's the same standard
this repo holds its own commits to.

## Pull request philosophy

Keep patches focused: one PR fixes one bug, adds one feature, or does one
refactor — not a mixture. Large, sprawling PRs are harder to review and
more likely to sit unreviewed.

**A higher bar applies to fund-safety-critical code** — anything in
`stellar.service.ts` that builds or signs a transaction, `auth-relay.service.ts`,
`wire-args.ts`, or `email-auth.service.ts`. This repo has a documented
history of exactly this class of bug (bug 1, 5, and 11 in the README's
bug log are all real examples of trade/fee code doing the wrong thing
silently) — any PR touching this surface should expect thorough review,
not a quick approve.

## Peer review

Anyone may review a pull request via comments. A review typically covers
whether the change is a good idea at all (concept), whether the approach
is right, and whether the code itself is correct.

- **`Concept (N)ACK`** — "I do (not) agree with the goal of this PR."
- **`Approach (N)ACK`** — "I agree with the goal, but (not) with how this
  achieves it."
- **`ACK <commit>`** — code review, plus a note on how you reviewed it:
  "I tested this against the live deployment by X" or "I read it and it
  looks correct, didn't run it."

A `NACK` needs a reason — an unexplained NACK can be disregarded. "Nit"
means a trivial, non-blocking issue (a typo, a naming preference) — don't
block a merge over one.

If you say you tested something, say how — "ran `npm test`" is different
from "hit the live endpoint and confirmed X," and readers of the PR
benefit from knowing which one happened.

## Decision making

Whether a PR merges is the maintainer's call, informed by peer review.
In general, a PR should:

- Fix a real, demonstrated problem or serve a clear purpose.
- Include a test that's confirmed to fail against the old code and pass
  against the fix — see the bug log for what that verification looks
  like in practice.
- Not break `npm test` or `npm run lint`.
- Update the README if it changes documented behavior (a new endpoint, a
  new env var, a changed response shape).

## Copyright

By contributing, you agree to license your work under the [MIT
license](./LICENSE), the same license this repository is distributed
under.
