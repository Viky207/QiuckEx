# Troubleshooting Guide

This guide maps the **stable public API error codes** returned by the service to their likely causes, the safe actions a user or integrator can take, and the escalation path for operators. It is intended for support staff and integrators who need to interpret API errors without reading implementation details.

> **Scope and source of truth**
> The codes documented here are sourced from the **canonical error registry**. Only codes marked as *public and stable* are included. Internal-only codes, diagnostic details, and sensitive remediation steps (for example, anything involving credentials, signing material, or infrastructure internals) are intentionally excluded from this document. If a code you receive is not listed here, see [Unknown or new codes](#unknown-or-new-codes).

---

## How to read an error response

Public API errors return a stable machine-readable `code` alongside a human-readable `message`. Always branch on the `code`, not on the `message` text, since messages may change without notice while codes remain stable.

```json
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "The requested resource does not exist."
  }
}
```

- **Likely cause** — the most common reasons this code is returned.
- **Safe user action** — steps an integrator or end user can take that do not require privileged access and do not expose sensitive information.
- **Operator escalation** — when and how to escalate to the service operators, including what non-sensitive context to include.

---

## Public error codes

### `INVALID_REQUEST`

- **Likely cause:** The request was malformed or missing required fields — for example, invalid JSON, a missing required parameter, or a value that fails validation.
- **Safe user action:** Check the request body and parameters against the API reference. Correct the malformed or missing fields and retry. Do not retry the identical request unchanged.
- **Operator escalation:** Usually not required. Escalate only if a request that matches the documented schema is consistently rejected; include the request shape (with secrets removed) and the timestamp.

### `UNAUTHENTICATED`

- **Likely cause:** No credentials were supplied, or the supplied credentials are missing, expired, or otherwise not accepted.
- **Safe user action:** Confirm that authentication credentials are present and current. Re-authenticate or refresh credentials through the supported flow, then retry. Never share credentials in support requests.
- **Operator escalation:** Escalate if valid, current credentials are consistently rejected. Provide the account identifier and timestamp only — never include tokens, keys, or signing material.

### `FORBIDDEN`

- **Likely cause:** The caller is authenticated but does not have permission to perform the requested action on the target resource.
- **Safe user action:** Verify the account's roles and permissions for the target resource. Request the appropriate access through your organization's normal access-request process.
- **Operator escalation:** Escalate if the account is expected to have access and the denial appears incorrect. Include the account identifier, the action attempted, and the timestamp.

### `RESOURCE_NOT_FOUND`

- **Likely cause:** The requested resource does not exist, or the caller does not have visibility into it.
- **Safe user action:** Verify the resource identifier is correct and that the resource has not been deleted or moved. Confirm you are operating in the correct account or scope.
- **Operator escalation:** Escalate if the resource is known to exist and should be visible to the caller. Include the resource identifier and timestamp.

### `CONFLICT`

- **Likely cause:** The request conflicts with the current state of the resource — for example, a concurrent modification or a duplicate create.
- **Safe user action:** Re-read the current resource state, reconcile your change, and retry. For duplicate-create conflicts, confirm whether the resource already exists before retrying.
- **Operator escalation:** Escalate if conflicts persist despite reconciling with current state. Include the resource identifier, the operation, and timestamps of the attempts.

### `RATE_LIMITED`

- **Likely cause:** The caller exceeded the allowed request rate or quota for the endpoint or account.
- **Safe user action:** Reduce request frequency and retry after the interval indicated in the response. Implement backoff and respect any retry guidance returned by the API.
- **Operator escalation:** Escalate if rate limiting occurs well within documented limits or if a quota increase is required. Include the endpoint, approximate request volume, and time window.

### `INTERNAL_ERROR`

- **Likely cause:** An unexpected condition occurred on the service side. This is not caused by the request content.
- **Safe user action:** Retry the request after a short delay using backoff. If the error persists across retries, stop retrying and escalate.
- **Operator escalation:** Escalate if the error persists after reasonable retries. Include the timestamp, endpoint, and any correlation or request identifier returned in the response (never include secrets).

### `SERVICE_UNAVAILABLE`

- **Likely cause:** The service or a dependency is temporarily unavailable, or the service is undergoing maintenance.
- **Safe user action:** Retry after a delay using backoff. Check the service status page if one is published. Avoid tight retry loops.
- **Operator escalation:** Escalate if unavailability persists beyond the expected maintenance or retry window. Include the timestamp and endpoint.

---

## Unknown or new codes

If you receive an error `code` that is **not listed in this guide**, treat it as follows:

1. **Do not assume the code is absent, deprecated, or safe to ignore.** New public codes may be added as the API evolves, and this guide may lag behind the canonical error registry.
2. **Branch defensively.** Handle unrecognized codes with a generic fallback: surface the `message` to the user, avoid automatic retries unless the code is known to be retryable, and log the code (not the full payload) for diagnostics.
3. **Flag for review.** Report the unrecognized code to the maintainers so it can be reconciled against the canonical error registry and, if public and stable, added to this guide. Include the code, the endpoint, and the timestamp — never include secrets or unnecessary personal data.
4. **Escalate if impact is significant.** If the unknown code blocks a critical workflow, escalate to operators using the same non-sensitive context described above.

Unrecognized codes are **flagged for review**, not assumed to be absent from the registry or permanently undocumented.

---

## What this guide intentionally excludes

To protect security and avoid leaking implementation details, this guide does **not** include:

- Internal-only error codes that are not part of the public contract.
- Diagnostic or stack-trace details.
- Remediation steps that involve credentials, signing material, or privileged infrastructure access.
- Any guidance that would require sharing secrets or unnecessary personal data in support requests.

For anything outside the scope of this guide, follow your organization's standard support and escalation process.