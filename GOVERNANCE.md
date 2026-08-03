# Governance

RunLume is maintained by a single maintainer, [@mlvpatel](https://github.com/mlvpatel).
This document states how the project is run so contributors can plan around it.

## Decision making

The maintainer decides what merges and what ships. Proposals arrive as issues,
discussions, or pull requests; anything touching the security boundary,
redaction behavior, pricing data, or the release pipeline gets extra scrutiny
as described in [CONTRIBUTING.md](CONTRIBUTING.md). There is no committee and
no voting; disagreement is resolved by discussion in the open issue.

## What keeps the project safe with one maintainer

- Protected `main` and release tags: every change lands through a pull request
  with required status checks, signed commits, and linear history; version
  tags cannot be deleted or moved.
- Reproducible releases: version tags build, attest, and publish releases
  automatically in CI, so a release never depends on one person's laptop.
- No runtime dependencies and pinned development tooling, which keeps the
  unattended surface small between releases.

## Response expectations

Best-effort, usually within a week for security reports through
[private vulnerability reporting](https://github.com/mlvpatel/RunLume/security/advisories/new)
and for reproducible bug reports. Feature requests may wait longer or be
declined to keep the project small.

## Continuity

If the maintainer becomes unreachable for 90 days with open security reports,
the project should be treated as unmaintained: fork it under the MIT license,
state clearly that the fork is independent, and do not reuse the `runlume`
npm package name or imply endorsement. The signed tags, SBOMs, and
attestations exist so a fork can verify exactly what it inherits.

## Adding maintainers

A contributor with a history of high-quality, security-conscious pull
requests may be invited as a co-maintainer. Co-maintainers get the same
constraints the current maintainer has: protected branches apply to everyone,
and release publishing stays behind two-factor authentication.
