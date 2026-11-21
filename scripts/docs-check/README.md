# Documentation gate

Dependency-free, offline validation that the published API, contract, and mobile
documentation still describes what the repository implements (issue
[#295](https://github.com/Viky207/QiuckEx/issues/295)).

```bash
node scripts/docs-check/check.mjs                     # all targets
node scripts/docs-check/check.mjs --only contract     # openapi | contract | mobile | migration
node scripts/docs-check/check.mjs --json              # machine-readable report
node --test scripts/docs-check/__tests__/docs.test.mjs
```

Exit codes: `0` clean, `1` errors, `2` usage error.

## Why

Documentation drift is silent. A controller is added, the OpenAPI document is
never regenerated, and the first person to find out is a client that gets a 404.
Nothing in review catches it, because a stale document still looks authoritative.

This gate reads the backend's route definitions **as text** and compares them
with the documentation. It never imports or starts the backend, so it runs on a
fresh clone before `pnpm install` and gives the same verdict on a fork.

## Targets

| Target | Reads | Enforces |
|---|---|---|
| `openapi` | `docs/openapi.json` | 3.x version, required `info`/`paths`, non-empty paths, every operation has responses, a tag, and a description, every tag used is declared, every `$ref` resolves, no schema referenced but undeclared, no unused schema |
| `contract` | every `*.controller.ts`, `docs/openapi.json`, `docs/BACKEND-CLIENT-CONTRACT-MAP.md`, `app/backend/src/main.ts` | every controller is documented in the OpenAPI document or the contract map; the documented "no global route prefix" claim still matches the code |
| `mobile` | `app/mobile/**`, `app/mobile/app.config.ts`, `app/mobile/README.md`, `.env.example` | every `EXPO_PUBLIC_*` variable the app reads is documented, and the API URL default is stated |
| `migration` | `docs/API-DEPRECATION-MIGRATION.md`, `docs/openapi.json` | the guide declares a version that matches `info.version` in the OpenAPI document, every replacement endpoint it names exists in the spec, and every entry carries a warning period, a replacement, and a compatibility test |

## Contract drift: how matching works

A controller counts as documented when **any of its path segments** appears
among the documented path segments. That is deliberate: the goal is to catch an
entirely undocumented module, not to police how the docs group routes. A
controller described only in the contract map's prose is a **warning**, not an
error — it is documented, just not in the generated spec.

## What it found

Running this against the repository surfaced **7 implemented but entirely
undocumented controllers** — `contacts`, `crash-reporting`, `dashboard-feed`,
`indexer` (5 routes), `manifests`, `teams` (9 routes), and
`transaction-timeline` — plus **3 undocumented `EXPO_PUBLIC_*` variables** used
by the mobile app. All are now documented; the gate keeps them from regressing.

## API deprecation migration guide

`docs/API-DEPRECATION-MIGRATION.md` is the template client authors follow when
an alias is retired (issue
[#580](https://github.com/Viky207/QiuckEx/issues/580)). It is versioned: the
`Guide version:` line must equal `info.version` in `docs/openapi.json`, so the
guide is bumped in the same change that bumps the API.

Each entry follows the existing alias policy and records:

- the deprecated alias and its supported replacement endpoint,
- a **warning period** expressed as a relative window (`T+0`, `T+30d`, …) with
  no calendar dates — maintainers fill in the actual dates at release time,
- the compatibility test that proves the replacement behaves like the alias.

The `migration` target fails when the guide version drifts from the spec, when a
named replacement endpoint is absent from `docs/openapi.json`, or when an entry
is missing one of the three required fields. Run it alone with:

```bash
node scripts/docs-check/check.mjs --only migration
```

## Adding a rule

1. Add the check to the relevant file in `lib/`.
2. Add a test under `__tests__/` covering the happy path and one violation.
3. Update the target table above and `docs/GOVERNANCE.md` §5.
