# API-Key Scope and Endpoint Matrix

This document is the maintained reference for API-key scopes. It maps every scope defined in `API_KEY_SCOPES` to the route families it unlocks, whether it grants read or write access, the environment in which it is available, and whether the operation is admin-only.

If you are creating a credential, use this table to pick the minimum set of scopes required for your integration. Scopes are additive: a key may hold several, and a request is authorized if **any** of its scopes permits the operation.

> **Note:** This file is checked against the scope constants and route guards in code. When you add or change a scope or guard, update this table in the same change. See [Keeping this table accurate](#keeping-this-table-accurate).

---

## Scope matrix

| Scope | Route family (controller prefix) | Access | Required environment | Admin-only | Notes |
| --- | --- | --- | --- | --- | --- |
| `links:read` | `/api/links` | Read | All environments | No | List and fetch short links. |
| `links:write` | `/api/links` | Write | All environments | No | Create, update, and delete short links. |
| `transactions:read` | `/api/transactions` | Read | All environments | No | List and fetch transactions. |
| `usernames:read` | `/api/usernames` | Read | All environments | No | Resolve and list usernames. |
| `refunds:write` | `/api/refunds` | Write | All environments | No | Create and update refunds. |
| `support:read` | `/api/support` | Read | All environments | No | Read support tickets and threads. |
| `support:write` | `/api/support` | Write | All environments | No | Reply to and update support tickets. |
| `admin` | `/api/admin`, `/api/api-keys` | Read + Write | All environments | **Yes** | Administrative operations and API-key lifecycle management. |

### Column definitions

- **Route family** — the controller prefix(es) the scope authorizes. Derived from controller route prefixes and guard metadata.
- **Access** — `Read` covers `GET`/`HEAD`; `Write` covers `POST`/`PUT`/`PATCH`/`DELETE`.
- **Required environment** — the environments in which the scope is honored. All current scopes are available in every environment.
- **Admin-only** — operations that additionally require the `admin` scope (or an org role of `admin`). These are rejected for any key that does not hold `admin`, regardless of other scopes.

---

## Admin-only operations

The following endpoints are guarded with `@RequireOrgRole('admin')` and require the `admin` scope. They are **not** reachable with any combination of non-admin scopes:

| Method | Path | Guard | Required scope |
| --- | --- | --- | --- |
| `POST` | `/api/api-keys` | `@RequireOrgRole('admin')` | `admin` |
| `DELETE` | `/api/api-keys/:id` | `@RequireOrgRole('admin')` | `admin` |
| `POST` | `/api/api-keys/:id/rotate` | `@RequireOrgRole('admin')` | `admin` |

Admin-only operations are clearly distinguished in the matrix above by the **Admin-only** column. A key that holds `admin` implicitly satisfies the read/write requirements of the administrative route family, but does **not** grant access to unrelated route families unless those scopes are also present.

---

## Unknown-scope rejection

API-key creation and update validate every requested scope against `API_KEY_SCOPES`. Any scope that is not in that allow-list is rejected:

- **Creation** (`POST /api/api-keys`) — the request fails with a validation error and no key is issued.
- **Update** (`PATCH /api/api-keys/:id`) — the request fails with a validation error and the existing key is left unchanged.
- **Authentication** — a key carrying an unrecognized scope is treated as invalid; requests are rejected rather than silently ignoring the unknown scope.

This fail-closed behavior ensures that a typo or a scope removed in a later release cannot accidentally widen access. When a scope is retired, existing keys holding it are rejected on use and must be rotated with a valid scope set.

---

## Examples

Requesting a read-only key for the links family:

```json
{
  "name": "links-reader",
  "scopes": ["links:read"]
}
```

Requesting a key that can manage API keys (admin-only):

```json
{
  "name": "key-admin",
  "scopes": ["admin"]
}
```

Requesting an unknown scope is rejected:

```json
{
  "name": "bad-key",
  "scopes": ["links:read", "links:superuser"]
}
```

> The examples above contain **no key material**. Never commit, log, or share issued key values. The API returns the secret only once, at creation time.

---

## Keeping this table accurate

The matrix is verified against the code in automated tests. When making changes:

1. Add or remove the scope in `API_KEY_SCOPES`.
2. Update the corresponding row(s) in the [Scope matrix](#scope-matrix).
3. If the change introduces an admin-only route, add it to [Admin-only operations](#admin-only-operations) and mark the scope's **Admin-only** column.
4. Run the scope-matrix coverage tests, which assert that every entry in `API_KEY_SCOPES` has a row here and that admin-guarded routes are listed as admin-only.

A scope present in code but missing from this table (or vice versa) is a test failure, so the table cannot silently drift from the implementation.