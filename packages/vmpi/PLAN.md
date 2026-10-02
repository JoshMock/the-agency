# Plan: broker host auth into vmpi without exposing `auth.json`

## Problem recap

`vmpi` deliberately omits `~/.pi/agent/auth.json` from the config snapshot that
becomes `/root/.pi` inside the VM (`vmpi.ts:26` `SNAPSHOT_DENIED`,
`snapshotFilter` at `vmpi.ts:34`, applied by the `cpSync` filter at
`vmpi.ts:573`). Consequence: pi inside the VM has no credentials and cannot
reach any model provider.

The existing `secrets` broker (host env var → guest placeholder env var, with
Gondolin's HTTP proxy substituting the real value only on allowed hosts) works
for providers that read an **API key from an env var** (anthropic, openai,
openrouter, gemini). It does **not** work for `github-copilot`, whose credential
is OAuth stored in `auth.json` (`type:"oauth"`, `refresh:"ghu_…"`, `access`,
`expires`). The copilot provider reads credentials from pi's credential store
(`auth.json`) with **no env-var fallback** — confirmed in
`dist/bundle/chunks/github-copilot.js`.

## Goal

Keep `auth.json` on the host (never copied into the VM, as today). Supply pi
inside the VM with a **synthetic `auth.json`** in which every secret token field
is a Gondolin **placeholder**. The real token lives only in the host-side proxy;
Gondolin substitutes placeholder → real value on egress, scoped to the
provider's auth host. The long-lived secret never materializes in the guest.

---

## Phase (a) findings — feasibility verified against pi 0.86.1

All anchors below are in the installed pi at:
`…/@earendil-works+pi-coding-agent@0.86.1/…/@earendil-works/pi-coding-agent/dist`

### 1. No token-shape / prefix validation on the refresh token

`github-copilot.js` → `refreshGitHubCopilotAccessToken(refreshToken, …)` sends
the stored refresh token verbatim:

```js
fetchJson(urls.copilotTokenUrl, {
  headers: { Accept:"application/json", Authorization:`Bearer ${refreshToken}`, ...COPILOT_HEADERS }, signal })
```

`urls.copilotTokenUrl` = `https://api.github.com/copilot_internal/v2/token`
(from `getUrls("github.com")`). The response is validated (`token` string,
`expires_at` number) but **the refresh token itself is never inspected** — no
`ghu_` prefix check, no length/shape check. A placeholder string passes through
unchanged and appears verbatim in the `Authorization` header. ✓

### 2. `auth.json` load validation is permissive

`core/auth-storage.js` validates each oauth credential as:

```js
value.type === "oauth" &&
typeof value.access === "string" &&
typeof value.refresh === "string" &&
typeof value.expires === "number" && Number.isFinite(value.expires)
```

No token-content checks. So a synthetic entry with `access:""`,
`refresh:"<PLACEHOLDER>"`, `expires:0` is valid. ✓

### 3. `expires:0` forces a refresh on first use

`dist/bundle/chunks/chunk-RCZIEVGO.js` → `resolveStoredOAuth(...)`:

```js
expiresSoon = c => Date.now() + minimumValidityMs >= c.expires;
if (expiresSoon(credential)) {
  await credentials.modify(providerId, async current => {
    if (current?.type === "oauth" && expiresSoon(current))
      return await oauth.refresh(current, refreshSignal);  // → refreshGitHubCopilotToken(current.refresh, …)
  }, { signal })
}
```

`expires:0` ⇒ `expiresSoon` true ⇒ pi calls `oauth.refresh`, which is
`refreshGitHubCopilotToken(credential.refresh, …)` (binding at
`github-copilot.js`: `githubCopilotOAuth.refresh = (credential,signal)=>refreshGitHubCopilotToken(credential.refresh,…)`).
That performs the `api.github.com` token mint using the placeholder (proxy
swaps it), then calls `fetchGitHubCopilotModels(credentials.access, …)` against
`*.githubcopilot.com` with the real short-lived access token. ✓

### 4. The refreshed real access token stays ephemeral

`credentials.modify` persists the refreshed credential back to `auth.json`, but
in the VM that path resolves to `/root/.pi` =
`new RealFSProvider(piConfigSnapshotDir)` — a **host temp dir**
(`mkdtempSync(... 'vmpi-pi-config-')`) that `cleanupSnapshot()` deletes on exit.
The outbound `collectSessionsFromVm` (`sessions.ts:96`) copies back **only**
`agent/sessions/<dir>` — never `auth.json`. So the real `~/.pi/agent/auth.json`
is never touched, and the short-lived copilot access token minted inside the VM
dies with the snapshot. ✓

### Security posture

- The long-lived `ghu_` refresh token — the asset worth protecting — never
  enters the guest. It exists only in the host proxy's substitution table.
- Only the ephemeral, copilot-scoped access token (minutes-long) materializes
  in-guest. This is the irreducible floor: pi must hold *some* bearer token
  in-guest to stream completions. Acceptable.
- API-key providers: the raw key likewise never enters the guest; the proxy
  injects it on the provider host only.

### Residual risk to re-check at implementation time

- `minOAuthValidityMs` / `DEFAULT_OAUTH_MINIMUM_VALIDITY_MS`: confirm no lower
  bound makes `expires:0` behave oddly (it only makes `expiresSoon` *more*
  likely true, so this is safe, but verify).
- Confirm no separate startup path validates `auth.json` more strictly than
  `resolveStoredOAuth` (e.g. a `vmpi`/pi "doctor" or model-registry warmer).
  `core/cache-warmer.js` references `expires` — check it tolerates `expires:0`
  (it should, since it would just trigger the same refresh).

---

## Phase (b) implementation plan

### Design overview

1. On the host, read the real `~/.pi/agent/auth.json`.
2. For each provider that (i) has a credential present in `auth.json` and
   (ii) is reachable under the configured network policy, register a Gondolin
   secret whose `value` is the real token and whose `placeholder` is a generated
   opaque string, scoped to the provider's auth host(s).
3. Build a **synthetic `auth.json`** containing the same providers but with
   token fields replaced by their placeholders (and, for oauth, `access:""`,
   `expires:0` to force refresh).
4. Write that synthetic `auth.json` into the snapshot dir **after** the
   `cpSync` (which excluded the real one).
5. The proxy substitutes placeholder → real token on egress to the scoped
   hosts.

This reuses `createHttpHooks`'s existing placeholder machinery: its returned
`env` map gives us `name → placeholder`, which we read and embed into the
synthetic `auth.json` rather than exporting as a guest env var.

### Credential models to support

Define a small table mapping pi provider id → how its `auth.json` entry is
shaped and which host(s) carry the secret. Drive it from the existing
`PROVIDER_DOMAINS` where possible.

| provider         | auth.json entry (real)                              | synthetic entry                                             | secret value   | scoped host(s)                 |
|------------------|-----------------------------------------------------|-------------------------------------------------------------|----------------|--------------------------------|
| `github-copilot` | `{type:"oauth", refresh, access, expires}`          | `{type:"oauth", refresh:PH, access:"", expires:0}`          | real `refresh` | `api.github.com`               |
| `anthropic`      | `{type:"api", key}` (confirm exact field name)      | `{type:"api", key:PH}`                                      | real `key`     | `api.anthropic.com`            |
| `openai`         | `{type:"api", key}`                                 | `{type:"api", key:PH}`                                      | real `key`     | `api.openai.com`               |
| `openrouter`     | `{type:"api", key}`                                 | `{type:"api", key:PH}`                                      | real `key`     | `openrouter.ai`                |
| `gemini`         | `{type:"api", key}` or oauth (confirm)              | mirror                                                      | real token     | `generativelanguage.googleapis.com` (+ oauth host if applicable) |

> **Verify before coding**: the exact `auth.json` schema for the non-oauth
> providers. Inspect `core/auth-storage.js` validation branches (there is an
> `type === "oauth"` branch; find the `"api"`/key branch) and a real multi-
> provider `auth.json` to confirm field names. The copilot shape is already
> confirmed above. Do **not** hardcode shapes that aren't verified; for
> unverified providers, start with copilot-only and extend.

> **Scope decision**: implement `github-copilot` first (the user's case),
> structured so adding API-key providers is a table entry, not new control flow.

### Code changes

All in `packages/vmpi/`. No new dependencies.

#### 1. `config.ts` — model the auth-brokering intent

Add a helper that, given the resolved network providers and the host
`auth.json`, produces:

- a `SecretsConfig`-shaped set of **auth secrets** (keyed by an internal secret
  name, e.g. `__vmpi_auth_<provider>_<field>`), each with `hosts` scoped to the
  provider's auth host and value read from the parsed `auth.json` (not from
  `process.env`); and
- a description of the synthetic `auth.json` to write (provider → placeholder
  field map).

Sketch:

```ts
/** One brokered auth secret: real value + where the proxy may send it. */
export interface AuthSecretPlan {
  /** internal secret name (also the key used to read its placeholder back) */
  secretName: string
  /** real token value read from host auth.json */
  value: string
  /** hostnames the proxy may substitute this secret into */
  hosts: string[]
  /** provider id in auth.json this secret belongs to */
  provider: string
  /** which synthetic auth.json field gets the placeholder */
  field: 'refresh' | 'key'
}

/** Per-provider rule describing how to broker its auth.json credential. */
interface AuthBrokerRule {
  /** credential kind as stored in auth.json */
  kind: 'oauth' | 'api'
  /** auth.json field holding the long-lived secret */
  secretField: 'refresh' | 'key'
  /** host(s) the secret field is sent to (subset of PROVIDER_DOMAINS) */
  secretHosts: (entry: any) => string[]
}

const AUTH_BROKER_RULES: Record<string, AuthBrokerRule> = {
  'github-copilot': {
    kind: 'oauth',
    secretField: 'refresh',
    // refresh token only goes to the token-mint host
    secretHosts: () => ['api.github.com'],
  },
  // anthropic/openai/... added after schema verification
}

/**
 * Reads the host auth.json and builds the auth-broker plan for providers that
 * are both present in auth.json and reachable under the network policy.
 * Pure/testable: takes parsed auth.json + provider list, returns the plan.
 */
export function planAuthBrokering (
  authJson: Record<string, any>,
  providers: string[] | undefined,
): AuthSecretPlan[] { /* ... */ }
```

- Read `auth.json` with the same tolerance as pi: `JSON.parse(stripBom(...))`,
  object-of-providers. On ENOENT or parse error, return `[]` (no brokering;
  behaves as today).
- Only include a provider if `AUTH_BROKER_RULES[provider]` exists **and** the
  provider id appears in `authJson` **and** the provider is in the effective
  network providers (so we never register a secret for a host that is blocked).
- The secret value comes straight from `auth.json`, so these entries bypass
  `resolveSecrets`' env-var lookup. Keep them separate from the existing
  env-var `secrets` map.

Wire into `loadConfig`/`ResolvedConfig`:

- Add `authSecrets: AuthSecretPlan[]` to `ResolvedConfig`.
- Populate it in `loadConfig` from `planAuthBrokering(readAuthJson(piConfigDir),
  trusted.network?.providers)`.
- Leave existing `secrets`/`missingSecrets` untouched (env-var brokering still
  works and composes).

> **Policy interaction**: today `github-copilot` auth needs
> `network.providers` to include `github-copilot` (so `api.github.com` and
> `*.githubcopilot.com` are allowed). If a user sets `policy: allow-all`,
> `allowedDomains` is empty but hosts are reachable; still register the secret
> so the proxy mediates it (mirrors the existing `allow-all` + secrets branch in
> `buildHttpHooks`). Decide: register auth secrets whenever the provider is in
> `auth.json`, independent of policy, but only if the provider's hosts are
> reachable (allow-all, or custom-with-provider). Document this.

#### 2. `vmpi.ts` — feed auth secrets into the proxy and synthesize auth.json

**a. Merge auth secrets into the Gondolin secrets passed to `createHttpHooks`.**

`buildHttpHooks(secrets, network)` currently takes only the env-var secrets.
Extend it to also accept the auth secrets (or merge upstream before calling).
Gondolin's `SecretDefinition` supports an explicit `placeholder`; we can let
Gondolin generate one and read it back from the returned `env` map (simplest),
keyed by `secretName`.

Convert each `AuthSecretPlan` into a Gondolin secret entry:

```ts
const authGondolinSecrets = Object.fromEntries(
  authSecrets.map(s => [s.secretName, { value: s.value, hosts: s.hosts }])
)
```

Merge with the existing `gondolinSecrets` before the `createHttpHooks` call in
all three policy branches (`allow-all`, `deny-all`, `custom`). Note: for
`deny-all` we would never register auth secrets (no reachable host), but guard
anyway.

`createHttpHooks` returns `env: { [secretName]: placeholder }`. We need those
placeholders for the synthetic `auth.json`, but we must **not** export the
`__vmpi_auth_*` placeholders as guest env vars (they're not meant to be env
vars). So:

- Change `buildHttpHooks` to return both the guest env (existing env-var
  secrets only) and a separate `authPlaceholders: Record<secretName,
  placeholder>` map, by partitioning the returned `env` by whether the key is an
  auth-secret name.

```ts
return { httpHooks, guestEnv, authPlaceholders }
```

**b. Write the synthetic `auth.json` into the snapshot.**

Right after the `cpSync(piConfigDir, piConfigSnapshotDir, { filter })` block
(`vmpi.ts:573`), add: if `authSecrets.length > 0`, build the synthetic
`auth.json` object and write it to
`join(piConfigSnapshotDir, 'agent', 'auth.json')`.

```ts
function buildSyntheticAuthJson (
  authSecrets: AuthSecretPlan[],
  placeholders: Record<string, string>,
): Record<string, any> {
  const out: Record<string, any> = {}
  for (const s of authSecrets) {
    const ph = placeholders[s.secretName]
    if (ph == null) continue
    if (s.field === 'refresh') {
      out[s.provider] = { type: 'oauth', refresh: ph, access: '', expires: 0 }
    } else {
      out[s.provider] = { type: 'api', key: ph }  // confirm schema
    }
  }
  return out
}
```

Write with `writeFileSync(authPath, JSON.stringify(obj, null, 2))`, creating
`agent/` if missing (it will already exist from the snapshot copy). Mode 0600
for tidiness (the file only contains placeholders, so this is cosmetic).

Because `createHttpHooks` runs in `buildHttpHooks` which is already called at
`vmpi.ts:545` **before** the snapshot block, the placeholders are available in
time. Confirm ordering when wiring.

**c. Update `vmpi policy` output.**

`renderPolicy` (`vmpi.ts` ~820) currently prints `Pi auth.json: not exposed`.
Change to reflect brokering, e.g.:

```
Pi auth.json:
  not exposed (host file never enters the VM)
  brokered credentials:
    github-copilot (refresh -> api.github.com, placeholder)
```

List each `AuthSecretPlan` (provider, field, hosts). Keep "host file never
enters the VM" prominent — that remains true.

#### 3. Guest reachability for the refresh flow

The copilot refresh path touches **both** `api.github.com` (token mint, needs
the brokered placeholder) and `*.githubcopilot.com` /
`api.individual.githubcopilot.com` (models + completions, uses the real
in-guest access token). Both are already in `PROVIDER_DOMAINS['github-copilot']`
(`config.ts:12`). No allowlist change needed **as long as** the user configures
`network.providers: ["github-copilot"]` or `policy: allow-all`. Document this
prerequisite; optionally detect providers present in `auth.json` and warn if
their domains are not reachable under the current policy.

### Tests (red-green TDD)

Pure functions first — no VM needed:

1. `config.test.ts`:
   - `planAuthBrokering` with a copilot oauth `auth.json` + providers
     `["github-copilot"]` → one `AuthSecretPlan` (secretName, value=refresh,
     hosts=`["api.github.com"]`, field=`refresh`).
   - provider in `auth.json` but **not** in network providers and policy
     custom → excluded.
   - policy allow-all → included.
   - missing/ENOENT `auth.json` → `[]`.
   - malformed `auth.json` → `[]` (no throw).
   - provider with no broker rule → excluded.
2. `vmpi.test.ts`:
   - `buildSyntheticAuthJson` maps an oauth plan + placeholder to
     `{type:"oauth", refresh:PH, access:"", expires:0}`.
   - `buildHttpHooks` partitions auth placeholders out of `guestEnv` and into
     `authPlaceholders`; env-var secrets still land in `guestEnv`.
   - (if feasible) an integration-ish test that the synthetic `auth.json` is
     written into the snapshot dir and validates against the same predicate pi
     uses (`type==="oauth" && typeof refresh==="string" && ...`). Encode that
     predicate in the test as a guard so a schema drift fails loudly.
3. Self-check for the token-shape assumption: a tiny `assert`-based check that
   the synthetic entry satisfies pi's documented validation predicate (copied
   into the test as the ceiling marker).

### Docs

- `README.md`: new subsection under the auth/security area explaining that
  `auth.json` stays on the host and credentials are brokered via Gondolin's
  proxy as placeholders; note the `network.providers` prerequisite; note that
  only short-lived derived tokens ever exist in-guest.
- `CHANGELOG.md`: entry.

### Rollout / fallback

- If `auth.json` is absent or has no brokerable providers, behavior is exactly
  as today (no synthetic file, pi unauthenticated). No regression for users who
  authenticate via env-var secrets.
- Keep the change additive: env-var `secrets` brokering and auth-file brokering
  compose; a user can use either or both.

### Open items to resolve during implementation

1. Exact `auth.json` schema for `anthropic`/`openai`/`openrouter`/`gemini`
   (field names, `type` tag) — verify from `core/auth-storage.js` and a real
   file before adding them to `AUTH_BROKER_RULES`. Ship copilot first.
2. Confirm `DEFAULT_OAUTH_MINIMUM_VALIDITY_MS` / cache-warmer tolerate
   `expires:0` (expected: yes).
3. Decide whether to export the copilot `access` placeholder too. Not needed:
   `access:""` + `expires:0` forces refresh, and the real access token is
   minted in-guest. Leaving `access` as a non-placeholder empty string is
   simplest and avoids a second secret.
4. Confirm Gondolin substitutes placeholders appearing in **request headers**
   (not just body/query). The copilot refresh sends the token in
   `Authorization`. The existing env-var secrets rely on the same
   header-substitution behavior, so this is already assumed to work; verify with
   one live run.
