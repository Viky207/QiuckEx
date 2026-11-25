# ADR-NNNN: Short imperative title

<!--
Copy this file to docs/adr/NNNN-kebab-case-title.md, replace NNNN with the next
free sequence number, and keep the section headings/order exactly as-is: the
governance gate (scripts/governance/check.mjs) fails the build otherwise.
Delete these instructions before opening the PR.
-->

## Status

Accepted <!-- Proposed | Accepted | Rejected | Deprecated | Superseded by ADR-NNNN -->

## Context

What forced a decision, what constraints exist (network, custody, compliance,
client compatibility), and what evidence supports them. Link the owning module
and any measurement, issue, or incident.

## Decision

The decision in one or two sentences, then the specific rules, invariants and
defaults it establishes. Name the owning module paths and config keys.

## Consequences

What becomes easier, what becomes harder, and what contributors must do
differently. Include the failure and degraded-mode behaviour this commits us to.

## Reversal Cost

How expensive reversal is (LOW / MEDIUM / HIGH / IRREVERSIBLE), who can reverse
it, and the exact procedure if one exists.

## Invariants Affected

Link the invariants from [../INVARIANTS.md](../INVARIANTS.md) that this decision
protects or constrains. Write `None` if the decision is not financial or
state-machine related.

## API Deprecation

<!--
Optional. Complete this section only when the decision deprecates an API alias
or endpoint. Follow the existing alias policy: every deprecated alias must name
its supported replacement, a warning period, and the compatibility tests that
prove clients can migrate. Leave timeline dates as placeholders (TBD) for
maintainers to fill in; do not invent dates.
-->

- **Deprecated alias / endpoint:** `<alias or endpoint>`
- **Replacement endpoint:** `<supported replacement>`
- **Warning period:** `<duration, e.g. N release cycles / N days>` (starts on `<TBD: warning start date>`)
- **Removal / sunset date:** `<TBD: sunset date>`
- **Migration timeline:**
  - `<TBD>` — warning announced, alias still served
  - `<TBD>` — alias returns deprecation warning header / log entry
  - `<TBD>` — alias removed, replacement only
- **Compatibility tests:** `<test paths proving the replacement satisfies the alias contract, including the failure/boundary case>`
- **Client migration guide:** `<link to the versioned migration template or docs>`

## References

- Owning code paths
- Related ADRs, policies, specs and external documentation