# API Deprecation Migration Guide

> **Guide version:** `1.0.0`
> **Tracks OpenAPI `info.version`:** `<OPENAPI_INFO_VERSION>` (update this value to match the `info.version` field in `openapi.yaml` at release time)
> **Last reviewed:** `<YYYY-MM-DD>`

This guide is for **client authors** consuming the API. It explains how to migrate from a deprecated alias to its supported replacement endpoint, following the existing alias policy. It is a versioned document: the guide version above is bumped whenever the alias policy or the set of documented aliases changes, and the tracked OpenAPI version is updated to match the `info.version` published in the spec.

Related references:

- **Capability map:** see the project capability map (e.g. `docs/capability-map.md`) to confirm which capability each alias and replacement endpoint belongs to before migrating.
- **ADR template:** see the architecture decision record template (e.g. `docs/adr/0000-adr-template.md`) for recording any deliberate contract change or migration decision.

---

## 1. Alias policy summary

The API follows a consistent alias deprecation policy:

| Aspect | Policy |
| --- | --- |
| **Deprecated alias** | An older endpoint path that remains available for backward compatibility. |
| **Replacement endpoint** | The supported endpoint that supersedes the alias and provides the same or extended behavior. |
| **Warning period** | The alias continues to function but emits deprecation signals (e.g. `Deprecation` and `Sunset` response headers, and a `deprecation` notice in the changelog). Clients should migrate during this window. |
| **Removal window** | After the warning period ends, the alias is removed. Requests to a removed alias return `410 Gone` (or `404 Not Found` where documented per alias). |
| **Compatibility guarantee** | During the warning period the alias preserves its existing request/response contract; only the replacement endpoint receives new fields or behavior. |

**Timeline rule:** maintainers fill in the timeline table below with real dates at announcement time. This guide intentionally ships with placeholders so no dates are invented. Do not treat placeholder values as commitments.

---

## 2. Fillable timeline

Maintainers complete this table when an alias is announced for deprecation. Each row corresponds to one alias.

| Alias | Replacement endpoint | Announcement date | Warning start | Warning end | Removal date |
| --- | --- | --- | --- | --- | --- |
| `<ALIAS_PATH>` | `<REPLACEMENT_PATH>` | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` |
| `<ALIAS_PATH>` | `<REPLACEMENT_PATH>` | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` | `<YYYY-MM-DD>` |

Guidance for maintainers:

- **Announcement date** — when the deprecation is published (changelog + this guide).
- **Warning start** — first date the alias emits deprecation signals.
- **Warning end** — last date the alias is guaranteed to function.
- **Removal date** — first date the alias returns `410 Gone` (or the documented status).

---

## 3. Per-alias migration sections

Duplicate the template below for each deprecated alias. Replace all `<...>` placeholders.

### 3.1 `<ALIAS_NAME>`

- **Deprecated alias:** `GET <ALIAS_PATH>`
- **Replacement endpoint:** `GET <REPLACEMENT_PATH>`
- **Capability:** `<CAPABILITY_NAME>` (see capability map)
- **Status:** `<Announced | Warning | Removed>`
- **Timeline:** see row for `<ALIAS_PATH>` in the timeline table above.

#### Request differences

| Field | Alias | Replacement | Notes |
| --- | --- | --- | --- |
| `<field>` | `<alias behavior>` | `<replacement behavior>` | `<migration note>` |

#### Response differences

| Field | Alias | Replacement | Notes |
| --- | --- | --- | --- |
| `<field>` | `<alias behavior>` | `<replacement behavior>` | `<migration note>` |

#### Compatibility test (curl)

```bash
# Verify the replacement endpoint returns the expected shape.
# Uses a placeholder token; never commit real credentials.
curl -sS \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Accept: application/json" \
  "https://api.example.test<REPLACEMENT_PATH>" \
  | jq '.data | {id, status}'
```

#### Compatibility test (unit test snippet)

```python
def test_replacement_endpoint_matches_alias_contract(client):
    """Replacement endpoint preserves the alias contract for migrated clients."""
    response = client.get("<REPLACEMENT_PATH>", headers={"Authorization": "Bearer test-token"})
    assert response.status_code == 200
    body = response.json()
    # Fields clients relied on from the alias must still be present.
    assert "id" in body["data"]
    assert "status" in body["data"]


def test_removed_alias_returns_gone(client):
    """After the removal date the alias returns 410 Gone (boundary case)."""
    response = client.get("<ALIAS_PATH>", headers={"Authorization": "Bearer test-token"})
    assert response.status_code == 410
```

> Examples use placeholder tokens and example hostnames only. Do not include secrets, signing material, or personal data in tests or documentation.

---

## 4. Client author checklist

- [ ] Identify every call to a deprecated alias in your client (search for `<ALIAS_PATH>`).
- [ ] Confirm the replacement endpoint and capability in the capability map.
- [ ] Review the request/response differences for the alias.
- [ ] Update client code to call the replacement endpoint.
- [ ] Add or update compatibility tests (see curl and unit test examples).
- [ ] Verify behavior against the replacement endpoint in a non-production environment.
- [ ] Confirm your client handles `410 Gone` (or documented status) for removed aliases.
- [ ] Record any deliberate contract change in an ADR using the ADR template.
- [ ] Remove references to the deprecated alias before the removal date.
- [ ] Monitor the changelog and this guide for timeline updates.

---

## 5. Maintainer checklist

- [ ] Fill in the timeline table with real dates at announcement time.
- [ ] Add a per-alias section with request/response differences.
- [ ] Confirm the alias emits deprecation signals during the warning period.
- [ ] Bump the guide version and update the tracked OpenAPI `info.version`.
- [ ] Link the relevant capability map entry and any ADR.
- [ ] Ensure examples contain no secrets or personal data.