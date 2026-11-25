# Support Bundle Privacy and Access Guide

This guide describes what support bundles contain, how they are collected, how sensitive data is redacted, who may access them, how long they are retained, and how to escalate or request deletion.

It applies to bundles produced by the application's crash-reporting and log-export paths (`CrashReportingService.captureCrash` and `exportLogs`) and to any bundle assembled manually by support staff from those sources.

## 1. Collection trigger

Support bundles are **opt-in**. Nothing is collected or uploaded unless one of the following occurs:

- **Crash reporting is enabled by the user** and a crash is captured through `CrashReportingService.captureCrash`. The service assembles a bundle from the crash context (stack trace, app/build metadata, recent in-memory log buffer) and hands it to the configured transport.
- **The user explicitly exports logs** via `exportLogs`. This produces a bundle from the current log buffer and metadata and is only created on direct user action.

There is no background or silent collection path. If crash reporting is disabled, `captureCrash` does not produce or transmit a bundle. Manual bundles assembled by support staff must originate from a user-initiated export or an opt-in crash report; staff must not reconstruct bundles from other data sources.

## 2. Redaction guarantees

All bundles pass through `RedactionService` before they are written or transmitted. The service scans structured fields and free-text log lines and replaces matches with a fixed placeholder (for example `[REDACTED]`). The following categories are redacted:

- **Stellar keys** — Stellar secret seeds (`S...`) and other Stellar key material are replaced. Public keys may remain where operationally necessary, but secret seeds never appear.
- **Bearer and JWT tokens** — `Authorization: Bearer ...` values and JWT-shaped strings (`eyJ...`) are replaced.
- **API keys** — values matching configured API-key patterns and known key header/field names are replaced.
- **Authorization headers** — the value of any `Authorization` header is replaced regardless of scheme.
- **Database connection strings** — connection URIs containing embedded credentials (for example `scheme://user:password@host`) are replaced.
- **Sensitive object keys** — object properties whose names indicate secrets (such as `password`, `secret`, `token`, `privateKey`, `apiKey`, `authorization`) have their values replaced.

### Guarantees and limits

- Redaction is applied to every bundle produced by `captureCrash` and `exportLogs`; there is no bypass flag exposed to callers.
- Redaction is **pattern-based**. It reliably catches the categories above in their standard forms, but it cannot guarantee removal of secrets that are split, encoded, or embedded in an unrecognized format. Treat bundles as potentially sensitive even after redaction.
- **Raw private keys must never be placed in a bundle.** Do not paste private keys, seed phrases, or signing material into support tickets, chat, or bundle metadata. If a user shares such material, stop, advise rotation, and delete the message per your organization's incident process.

### Examples (safe — no credentials)

A redacted log line looks like this:

```
[REDACTED] POST /v1/accounts headers={"Authorization":"[REDACTED]"}
[REDACTED] connecting to [REDACTED]
[REDACTED] config.apiKey=[REDACTED]
```

When describing a problem, refer to the *kind* of value rather than the value itself, e.g. "the API key in the request header was rejected" — never include the key.

## 3. Access restriction

- Bundles are stored in the restricted support-bundle location configured for the environment, not in general-purpose storage or shared drives.
- Access is limited to the **Support Bundle Custodian** role and, on a need-to-know basis, the on-call engineer investigating the specific report.
- Access is granted per-incident and revoked when the incident closes.
- Bundles must not be attached to public issues, pasted into public chat, or shared outside the organization.
- Downloads and views are logged (who, when, which bundle) for audit.

## 4. Retention

- Bundles are retained for the configured retention window (default: **30 days**) from collection, after which they are deleted automatically.
- Bundles linked to an open incident may be retained until the incident is closed, then deleted at the end of the next retention cycle.
- Retention is enforced by the storage lifecycle policy; do not copy bundles to longer-lived storage.

## 5. Escalation process

1. **Suspected secret exposure** (a credential or key appears in a bundle or ticket): stop sharing, delete the affected bundle/message, notify the **Security Lead**, and initiate rotation of the exposed credential.
2. **Access request** beyond the standard role: route to the **Support Bundle Custodian**, who approves or denies and records the decision.
3. **Deletion request** from a user or due to policy: route to the **Support Bundle Custodian**, who deletes the bundle and confirms completion.
4. **Redaction gap** (a category that should be redacted is not): file a bug against `RedactionService`, treat existing bundles as sensitive, and re-review them after the fix.

## 6. Named responsibilities

| Responsibility | Owner |
| --- | --- |
| Approving and revoking bundle access | Support Bundle Custodian |
| Deleting bundles on request or at end of retention | Support Bundle Custodian |
| Handling suspected secret exposure and credential rotation | Security Lead |
| Maintaining and fixing redaction rules | Engineering (owner of `RedactionService`) |
| Auditing access logs | Security Lead |

Names for these roles are maintained in the team's on-call/ownership directory; this guide defines the roles, and the directory identifies the current individuals.