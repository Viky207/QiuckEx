# Contributing

Thanks for contributing! Please read this guide before opening a pull request.

## Getting started

1. Fork the repository and create a feature branch.
2. Install dependencies and run the existing test suite locally.
3. Make focused changes that address a single issue.
4. Open a pull request describing the change and linking the issue.

## Code style

- Follow the existing patterns, naming, and module structure.
- Keep changes surgical; avoid unrelated refactors.
- Do not commit secrets, signing material, or unnecessary personal data.

## Tests

- Add focused automated coverage for any changed behavior, including the relevant failure or boundary case.
- Preserve existing public contracts unless a deliberate migration is included.

## Contract budget regression tests

The contract test suite includes budget regression cases that exercise worst-case call paths under the declared limits (CPU instructions and storage growth). These tests are reproducible and run in contract CI.

- Exceeding a declared budget limit fails the CI job.
- Budget thresholds are checked into the repository alongside the tests.
- **Changing a budget threshold requires an explicit review note** in the pull request explaining why the limit changed and what worst-case input justifies the new value. Threshold changes without a review note should be rejected.

## Pull requests

## Branch Naming

- Feature branches: `feat/<short-description>`
- Bugfix branches: `fix/<short-description>`
- Docs branches: `docs/<short-description>`
- Chores: `chore/<short-description>`

## Filing Issues

Use one of the templates in `.github/ISSUE_TEMPLATE`:

| Template | Use it when |
|---|---|
| **Bug report** | Something behaves differently from what the docs say. |
| **Feature request** | Proposing a new capability or a change to an existing one. |
| **Architecture decision record** | The decision is expensive to reverse — see [docs/adr/](docs/adr/). |

Before filing, check [docs/CAPABILITY-MAP.md](docs/CAPABILITY-MAP.md). Several flows
that look broken are labeled **Mocked** or **Partial** there, and the fix is often
wiring an existing backend endpoint to its client rather than building something new.

## Labels

Labels are declared in [`.github/labels.yml`](.github/labels.yml) and applied to the
repository by an idempotent script. Apply or inspect them with:

```bash
pnpm labels:sync            # create/update labels (safe to repeat)
pnpm labels:check           # report drift, change nothing
pnpm labels:sync -- --prune # also delete labels not in the file
```

`.github/workflows/sync-labels.yml` runs the same script daily and on any change to
the file, so the repository and the file cannot drift apart silently.

### CI job conventions

Every job in `.github/workflows/*.yml` declares a `timeout-minutes` bound
(and network-heavy steps add their own step-level timeout on top of it), so a
hung install, test run, or external call fails fast instead of consuming a
runner indefinitely. Jobs that can fail in a way that isn't obvious from the
job name (deploys, gates, long test suites) write a short failure summary to
`$GITHUB_STEP_SUMMARY` — what failed and where to look next (a runbook under
`docs/`, an uploaded artifact) — instead of leaving the reader to open raw
logs. No step logs or echoes credentials; secrets are only ever referenced
via `${{ secrets.* }}` inside `env:`.

The vocabulary is deliberately small:

| Prefix | Answers | Examples |
|---|---|---|
| *(none)* / `type:` | What kind of change? | `bug`, `type:security`, `type:tech-debt`, `type:mocked-to-live` |
| `area:` | Which surface? | `area:frontend`, `area:backend`, `area:mobile`, `area:contract`, `area:docs`, `area:ci` |
| `network:` | Which Stellar network? | `network:testnet`, `network:mainnet` |
| `custody:` | Does it touch money or keys? | `custody:sensitive` |
| `needs:` | What must happen before merge? | `needs:breaking-change`, `needs:migration`, `needs:design` |
| `status:` | Where is the issue? | `status:needs-triage`, `status:accepted`, `status:blocked`, `status:done` |
| `P0`–`P3` | How urgent? | `P0` is the highest |

Two rules carry the most weight:

- **`custody:sensitive` on anything touching settlement, key handling, or the
  invariants in [docs/INVARIANTS.md](docs/INVARIANTS.md).** These get maintainer
  review regardless of size. See [ADR 0001](docs/adr/0001-self-custody-no-intermediary-custody.md).
- **`network:mainnet` on anything touching mainnet.** All `mainnet.*` feature flags
  default to disabled, and enabling one is a reviewed, reversible act. See
  [ADR 0002](docs/adr/0002-testnet-first-mainnet-feature-gated.md).

## Architecture Decision Records

Write an ADR when the change introduces or removes a service or datastore, changes
who holds keys or funds, changes the settlement or refund flow, breaks a public
endpoint family, or replaces a **Mocked**/**Partial** row with something users can
rely on. Pure UI work, bug fixes that restore documented behavior, and CI changes
do not need one.

- Format and index: [docs/adr/README.md](docs/adr/README.md)
- Start from the ADR issue template
- File it **in the same PR** as the implementation, labeled `needs:design`
- Never edit an Accepted ADR to change its meaning — supersede it and link the successor

Existing decisions worth reading before you propose an architecture change:

| ADR | Decision |
|---|---|
| [0001](docs/adr/0001-self-custody-no-intermediary-custody.md) | Self-custodial; no intermediary holds funds |
| [0002](docs/adr/0002-testnet-first-mainnet-feature-gated.md) | Testnet-first, mainnet behind disabled-by-default flags |
| [0003](docs/adr/0003-supabase-as-system-of-record.md) | Supabase is the only system of record |
| [0004](docs/adr/0004-canonical-status-vocabulary.md) | Live/Partial/Mocked/Experimental is the only status vocabulary |

## Pull Request Guidelines

- Reference the issue number in your PR description (`closes #123`).
- Add clear, descriptive titles.
- Ensure all tests pass before requesting review. The fastest way to know is `./scripts/rc-validate.sh` — the same gate CI runs. See [docs/RELEASE-CANDIDATE-VALIDATION.md](docs/RELEASE-CANDIDATE-VALIDATION.md).
- Follow the [Conventional Commits](https://www.conventionalcommits.org/) style.
- Add/Update documentation as needed.
- If your change alters what is actually shipped, update the matching row in [docs/CAPABILITY-MAP.md](docs/CAPABILITY-MAP.md) in the same PR ([ADR 0004](docs/adr/0004-canonical-status-vocabulary.md)).
- If your change touches settlement, key handling, or fees, label it `custody:sensitive` ([ADR 0001](docs/adr/0001-self-custody-no-intermediary-custody.md)).

## 8-Week MVP Roadmap & Feature Prioritization

See [docs/MVP-ROADMAP.md](docs/MVP-ROADMAP.md) for the full roadmap and priorities.

## Architecture Overview

- Backend and Contract architecture diagrams are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- Check [docs/CAPABILITY-MAP.md](docs/CAPABILITY-MAP.md) to see which flows are Live, Partial, Mocked, or Experimental before building on them.
- See [docs/](docs/) for API, events, and payment flow documentation.

## Getting Help

- Check the [README.md](README.md) for project overview.
- Ask in Discussions or open an Issue if you’re stuck.

Happy contributing!
