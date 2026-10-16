# Security Policy

This document is the canonical security vulnerability disclosure policy for this
repository. It is mirrored at [`SECURITY.md`](../SECURITY.md) and
[`docs/security.md`](../docs/security.md).

## Scope

### In scope

- **Smart contracts** — Solidity sources under `contracts/`, deployed bytecode,
  and deployment/upgrade scripts.
- **Backend API** — services under `backend/` (REST/GraphQL endpoints,
  authentication, authorization, transaction signing, key handling).
- **Frontend** — web application under `frontend/` (client-side logic, wallet
  integration, XSS/CSRF, dependency supply chain).

### Out of scope

- Third-party infrastructure and services we do not control (RPC providers,
  hosting/CDN, wallet browser extensions, block explorers, npm/registry
  infrastructure).
- Issues requiring physical access to a device, or social engineering of
  maintainers or users.
- Denial-of-service via volumetric traffic, spam, or resource exhaustion against
  shared infrastructure.
- Findings from automated scanners without a demonstrated, exploitable impact.
- Already-public issues, or issues disclosed without following this policy.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report privately using either channel:

1. **GitHub private security advisory** (preferred) — use the *Report a
   vulnerability* button in the repository's **Security** tab.
2. **Email** — `security@example.com`. Encrypt sensitive details with our PGP
   key where possible.

Include, where available:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept, transaction hash, or request/response).
- Affected component(s) and version/commit.
- Any suggested remediation.

## Response SLA

| Stage | Target |
| --- | --- |
| Acknowledgement of report | within **48 hours** |
| Triage and severity classification | within **7 days** |
| Fix for **P0** | within **72 hours** |
| Fix for **P1** | within **14 days** |
| Fix for **P2/P3** | next scheduled release |

We will keep you informed of progress and coordinate a disclosure timeline with
you before any public write-up.

## Severity classification

Severity uses the same P0–P3 labels as the rest of the repository:

- **P0 — Critical:** Direct loss or theft of funds, private key compromise, or
  unauthenticated remote code execution. Fix within 72 hours.
- **P1 — High:** Conditional loss of funds, authentication/authorization bypass,
  or significant data exposure. Fix within 14 days.
- **P2 — Medium:** Limited-impact issues requiring unusual preconditions, or
  partial information disclosure. Fix in the next scheduled release.
- **P3 — Low:** Minor issues with negligible impact (hardening, best-practice
  deviations). Addressed as capacity allows.

## Safe harbour

We consider security research conducted in good faith to be authorised. We will
not pursue or support legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, data destruction, and
  interruption or degradation of our services.
- Only interact with accounts they own or have explicit permission to test.
- Report vulnerabilities promptly through the channels above and give us a
  reasonable opportunity to remediate before public disclosure.
- Do not exploit a vulnerability beyond the minimum necessary to demonstrate it.

If legal action is initiated by a third party against you for such research, we
will make this policy publicly known.

## Recognition

With your permission, we are happy to credit reporters in the release notes for
the fix.
