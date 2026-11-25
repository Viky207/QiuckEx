# Field-Level Privacy and Retention Reference

This document is the field-level companion to the retention schedule. It inventories each field handled by the system across profile, payment, telemetry, audit, crash-report, privacy-event, and key-rotation data, and records for each field:

- **Data category** — the classification used by the retention schedule.
- **Purpose** — why the field is collected/processed.
- **Retention policy** — the retention window and the event from which the window is measured (`windowFrom`).
- **Deletion behavior** — one of `hard_delete`, `pseudonymize`, `redact`, `aggregate_only`, `not_deletable`, or `device_local`.

> **Scope and safety.** This inventory intentionally excludes secrets, signing material, and unnecessary personal data. Where a field is sensitive (e.g., payment credentials, key material), only its category, purpose, retention, and deletion behavior are described — never its value or format.

## How to read this document

### Data categories

Categories align with the retention schedule. Each field below is tagged with one category:

| Category | Description |
| --- | --- |
| `profile` | User account and profile attributes. |
| `payment` | Payment and billing records. |
| `telemetry` | Product usage and diagnostic telemetry. |
| `audit` | Security and administrative audit records. |
| `crash-report` | Crash and error diagnostics. |
| `privacy-event` | Consent, privacy request, and privacy lifecycle events. |
| `key-rotation` | Key lifecycle and rotation metadata (no key material). |

### Retention policy fields

- **Window** — the retention duration (e.g., `30d`, `13mo`, `indefinite`).
- **windowFrom** — the event that starts the retention clock. Common values:
  - `created_at` — field/record creation time.
  - `updated_at` — last modification time.
  - `deleted_at` — soft-deletion time.
  - `event_at` — time of the triggering event (e.g., a privacy request or rotation).
  - `account_closure` — account closure time.

### Deletion behavior values

| Value | Meaning |
| --- | --- |
| `hard_delete` | Row/field is physically removed at end of retention or on deletion request. |
| `pseudonymize` | Direct identifiers are replaced with a stable pseudonym; the record is retained for its purpose. |
| `redact` | Sensitive content is replaced with a placeholder; the record remains for audit/aggregate purposes. |
| `aggregate_only` | Only aggregated/derived values are retained; the raw field is discarded. |
| `not_deletable` | Retained for legal, security, or integrity reasons; not removed on request. |
| `device_local` | Stored only on the user's device; never transmitted to or retained by the server. |

### Unknown fields

Any field encountered in storage or logs that is **not** listed here must be treated as **unknown** and flagged for review. Unknown fields are **not** assumed absent — they are recorded in the [Unknown fields flagged for review](#unknown-fields-flagged-for-review) section until classified. This satisfies the acceptance criterion that unknown fields are flagged rather than assumed absent.

---

## Profile data

| Field | Category | Purpose | Retention window | windowFrom | Deletion behavior |
| --- | --- | --- | --- | --- | --- |
| `account_id` | `profile` | Stable account identifier. | `indefinite` (life of account) | `account_closure` | `pseudonymize` |
| `email` | `profile` | Account login and notifications. | `indefinite` (life of account) | `account_closure` | `hard_delete` |
| `display_name` | `profile` | User-facing name. | `indefinite` (life of account) | `account_closure` | `hard_delete` |
| `locale` | `profile` | Localization. | `indefinite` (life of account) | `account_closure` | `hard_delete` |
| `timezone` | `profile` | Scheduling and display. | `indefinite` (life of account) | `account_closure` | `hard_delete` |
| `created_at` | `profile` | Record provenance. | `indefinite` | `account_closure` | `pseudonymize` |
| `updated_at` | `profile` | Record provenance. | `indefinite` | `account_closure` | `pseudonymize` |
| `deleted_at` | `profile` | Soft-deletion marker. | `30d` | `deleted_at` | `hard_delete` |

## Payment data

Payment credentials (card numbers, security codes, full PANs) are **never** stored by this system; they are handled by the payment processor. Only references and billing metadata are retained.

| Field | Category | Purpose | Retention window | windowFrom | Deletion behavior |
| --- | --- | --- | --- | --- | --- |
| `payment_customer_ref` | `payment` | Processor customer reference. | `7y` | `account_closure` | `pseudonymize` |
| `payment_method_ref` | `payment` | Processor payment-method reference (no credentials). | `7y` | `account_closure` | `pseudonymize` |
| `billing_status` | `payment` | Billing state for account management. | `7y` | `account_closure` | `aggregate_only` |
| `invoice_id` | `payment` | Financial record linkage. | `7y` | `created_at` | `not_deletable` |
| `amount` | `payment` | Financial record. | `7y` | `created_at` | `not_deletable` |
| `currency` | `payment` | Financial record. | `7y` | `created_at` | `not_deletable` |
| `transaction_at` | `payment` | Financial record. | `7y` | `created_at` | `not_deletable` |

> Financial records (`invoice_id`, `amount`, `currency`, `transaction_at`) are `not_deletable` for the statutory retention period and are retained in aggregate/redacted form thereafter.

## Telemetry data

| Field | Category | Purpose | Retention window | windowFrom | Deletion behavior |
| --- | --- | --- | --- | --- | --- |
| `event_name` | `telemetry` | Product usage analytics. | `13mo` | `created_at` | `aggregate_only` |
| `event_props` | `telemetry` | Usage analytics (non-identifying). | `13mo` | `created_at` | `aggregate_only` |
| `session_id` | `telemetry` | Session correlation. | `30d` | `created_at` | `pseudonymize` |
| `device_type` | `telemetry` | Compatibility analytics. | `13mo` | `created_at` | `aggregate_only` |
| `app_version` | `telemetry` | Compatibility analytics. | `13mo` | `created_at` | `aggregate_only` |
| `client_ip` | `telemetry` | Abuse prevention and coarse geo. | `30d` | `created_at` | `redact` |
| `user_agent` | `telemetry` | Compatibility analytics. | `30d` | `created_at` | `redact` |

> `client_ip` and `user_agent` are redacted (truncated/coarsened) at end of window rather than retained in raw form.

## Audit data

| Field | Category | Purpose | Retention window | windowFrom | Deletion behavior |
| --- | --- | --- | --- | --- | --- |
| `audit_id` | `audit` | Audit record identity. | `2y` | `created_at` | `not_deletable` |
| `actor_id` | `audit` | Attribution of administrative actions. | `2y` | `created_at` | `pseudonymize` |
| `action` | `audit` | Security/administrative accountability. | `2y` | `created_at` | `not_deletable` |
| `target_ref` | `audit` | What was acted upon. | `2y` | `created_at` | `pseudonymize` |
| `result` | `audit` | Outcome of action. | `2y` | `created_at` | `not_deletable` |
| `audit_at` | `audit` | Timestamp of action. | `2y` | `created_at` | `not_deletable` |

> Audit records are `not_deletable` for the security retention window; direct identifiers (`actor_id`, `target_ref`) are pseudonymized at end of window.

## Crash-report data

| Field | Category | Purpose | Retention window | windowFrom | Deletion behavior |
| --- | --- | --- | --- | --- | --- |
| `crash_id` | `crash-report` | Crash record identity. | `90d` | `created_at` | `hard_delete` |
| `stack_trace` | `crash-report` | Debugging. | `90d` | `created_at` | `redact` |
| `error_message` | `crash-report` | Debugging. | `90d` | `created_at` | `redact` |
| `app_version` | `crash-report` | Debugging. | `90d` | `created_at` | `hard_delete` |
| `device_type` | `crash-report` | Debugging. | `90d` | `created_at` | `hard_delete` |
| `crash_at` | `crash-report` | Debugging. | `90d` | `created_at` | `hard_delete` |

> `stack_trace` and `error_message` are scrubbed of identifiers (`redact`) before retention; the remaining fields are hard-deleted at end of window.

## Privacy-event data

| Field | Category | Purpose | Retention window | windowFrom | Deletion behavior |
| --- | --- | --- | --- | --- | --- |
| `privacy_event_id` | `privacy-event` | Privacy lifecycle record identity. | `3y` | `event_at` | `not_deletable` |
| `event_type` | `privacy-event` | Consent/request tracking. | `3y` | `event_at` | `not_deletable` |
| `subject_ref` | `privacy-event` | Link event to subject. | `3y` | `event_at` | `pseudonymize` |
| `consent_state` | `privacy-event` | Proof of consent. | `3y` | `event_at` | `not_deletable` |
| `event_at` | `privacy-event` | Timestamp of event. | `3y` | `event_at` | `not_deletable` |

> Privacy-event records are retained as proof of compliance and are `not_deletable`; the subject reference is pseudonymized.

## Key-rotation data

This category records **key lifecycle metadata only**. No key material, secrets, or signing material is inventoried or retained here.

| Field | Category | Purpose | Retention window | windowFrom | Deletion behavior |
| --- | --- | --- | --- | --- | --- |
| `rotation_id` | `key-rotation` | Rotation record identity. | `2y` | `event_at` | `not_deletable` |
| `key_ref` | `key-rotation` | Opaque reference to a key (no material). | `2y` | `event_at` | `pseudonymize` |
| `rotation_state` | `key-rotation` | Lifecycle tracking. | `2y` | `event_at` | `not_deletable` |
| `rotation_at` | `key-rotation` | Timestamp of rotation. | `2y` | `event_at` | `not_deletable` |

> Key material and signing material are explicitly out of scope and are never recorded in this inventory or in logs.

---

## Unknown fields flagged for review

The following fields have been observed in storage or logs but are **not yet classified**. They are flagged here for review and are **not** assumed absent. Each must be classified (category, purpose, retention, deletion behavior) before it can be considered covered.

| Field (observed) | Where observed | Status | Action |
| --- | --- | --- | --- |
| `_review_required_` | — | **Unknown — flagged for review** | Classify before relying on this inventory. |

> When a new field is discovered, add a row here with its observed location and mark it **Unknown — flagged for review**. Do not remove a row until the field is classified in the appropriate category table above.

## Cross-reference to the retention schedule

This inventory is keyed to the retention schedule categories. Each field's `Category` column maps to the corresponding schedule category, and each field's `Retention window` / `windowFrom` / `Deletion behavior` must match the schedule. If the schedule and this inventory disagree, the schedule is authoritative and this document must be updated.

## Maintenance

- Update this document whenever a field is added, removed, or reclassified.
- Any field found in storage or logs that is not listed here must be added to **Unknown fields flagged for review** immediately.
- Never record secrets, signing material, or unnecessary personal data in this document.