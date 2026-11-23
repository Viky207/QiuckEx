# Environment Precedence

This document is the reference for how environment configuration is resolved across the
backend, frontend, and mobile apps. It describes variable names, defaults, precedence
order, and how the selected network is surfaced in each app.

> **Placeholders only.** All examples in this document use placeholder values
> (e.g. `<API_BASE_URL>`, `<NETWORK>`, `<RPC_URL>`). Never commit real secrets,
> signing material, or production endpoints to documentation or example files.

## Precedence order

For every app, configuration is resolved in the following order, highest priority first:

1. **Process environment** — variables set in the shell, container, or CI/CD platform
   (e.g. `export VAR=value`, `docker run -e VAR=value`, platform secret stores).
2. **Environment file** — values loaded from a local `.env*` file (see per-app notes
   below for which files are read and in what order).
3. **Built-in default** — the value compiled into the application when neither of the
   above is present.

A value from a higher-priority source always wins; lower-priority sources are never
merged over it. Empty strings are treated as unset for the purposes of this precedence.

## Mainnet defaults

Several defaults intentionally point at **mainnet**. These are called out explicitly
below so that local and preview environments do not accidentally call a mainnet API or
network. If you are running locally or in preview, set the corresponding variables
explicitly to a non-mainnet value.

- Backend: the default network is **mainnet** unless `NETWORK` is set.
- Frontend: the default API base URL targets the **mainnet** backend unless
  `NEXT_PUBLIC_API_BASE_URL` is set.
- Mobile: the default environment is **mainnet** unless `APP_ENV` selects another
  environment.

## Backend

### Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `NETWORK` | `mainnet` | Selects the network the backend talks to. **Mainnet default.** |
| `RPC_URL` | _(network-dependent)_ | Overrides the RPC endpoint for the selected network. |
| `API_PORT` | `8080` | Port the HTTP server binds to. |
| `LOG_LEVEL` | `info` | Logging verbosity. |

### Precedence

1. Process environment (e.g. `NETWORK=<NETWORK>`).
2. `.env` file in the backend working directory.
3. Built-in defaults from the table above.

### How the selected network is surfaced

- **Bootstrap:** on startup the backend resolves `NETWORK` using the precedence above,
  logs the resolved network name (never the RPC URL or credentials), and fails fast if
  the value is not a recognized network.
- **Network endpoints:** the resolved network is exposed via the network info endpoint
  (e.g. `GET /network`) so clients can confirm which network they are talking to. The
  response contains the network name only — no endpoints or secrets.

Example (placeholders only):

```sh
# Process environment wins over .env and defaults
NETWORK=<NETWORK> RPC_URL=<RPC_URL> API_PORT=<API_PORT> ./backend
```

## Frontend

### Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_API_BASE_URL` | mainnet backend URL | Base URL for backend API calls. **Mainnet default.** |
| `NEXT_PUBLIC_NETWORK` | `mainnet` | Network label shown in the UI. **Mainnet default.** |

`NEXT_PUBLIC_*` variables are inlined at build time and are therefore **public** — never
put secrets in them.

### Precedence

1. Process environment at build/start time (e.g. `NEXT_PUBLIC_API_BASE_URL=<API_BASE_URL>`).
2. `.env.local`, then `.env` (Next.js file loading order).
3. Built-in defaults from the table above.

### How the selected network is surfaced

- `next.config` reads the `NEXT_PUBLIC_*` variables and exposes them to the client
  bundle via the `env` key, applying the same precedence.
- The UI displays the resolved network (from `NEXT_PUBLIC_NETWORK`) in the app header
  and on the settings page so users can see which network is active.

Example (placeholders only):

```sh
NEXT_PUBLIC_API_BASE_URL=<API_BASE_URL> NEXT_PUBLIC_NETWORK=<NETWORK> npm run build
```

## Mobile

### Variables

| Variable | Default | Notes |
| --- | --- | --- |
| `APP_ENV` | `mainnet` | Selects the environment entry from `ENVIRONMENTS`. **Mainnet default.** |

### Precedence

1. Process environment at build time (`APP_ENV=<APP_ENV>`).
2. `.env` file in the mobile project root.
3. Built-in default (`mainnet`).

### How the selected network is surfaced

- The `ENVIRONMENTS` map defines per-environment settings (API base URL, network name).
  `APP_ENV` selects the active entry using the precedence above.
- `EnvironmentContext` provides the resolved environment to the component tree. The
  active environment name is rendered in the app's settings/debug screen so testers can
  confirm which network is in use.

Example (placeholders only):

```sh
APP_ENV=<APP_ENV> npm run build
```

## Verification

This document is checked by the `docs-check` rule, which validates that:

- Every variable named here exists in the corresponding schema or config source.
- Examples contain placeholders only (no literal URLs, keys, or secrets).
- Mainnet defaults are explicitly called out.

If you add or rename a variable, update this file and the corresponding schema in the
same change.