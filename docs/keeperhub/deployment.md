# Deploying KeeperCard with KeeperHub

Two services: the dashboard on Cloudflare Workers, the API on Render. The KeeperHub
integration lives entirely in the API.

## 1. Dashboard — Cloudflare Workers

`NEXT_PUBLIC_*` is **inlined at build time**, so the API base and the chain id are baked
into the bundle. Building with the wrong chain id produces signatures the executor cannot
redeem, because a signed delegation carries the chain id.

```bash
export NEXT_PUBLIC_ATTESTPAY_API="https://attestpay-api.onrender.com/api"
export NEXT_PUBLIC_ATTESTPAY_CHAIN_ID="84532"        # MUST match the API's ATTESTPAY_CHAIN_ID
bun run --cwd packages/dashboard cf:build
bun run --cwd packages/dashboard cf:deploy
```

Live at `https://keepercard-dashboard.adoranto737.workers.dev`. The execution console is at
`/keeperhub`, behind the ordinary Privy sign-in.

Verify the right values were baked in before trusting a deploy:

```bash
grep -rho "attestpay-api.onrender.com[^\"']*" packages/dashboard/.open-next | sort -u
```

## 2. API — Render

> **Why the host says `attestpay-api`.** Render pins the hostname a service was *created*
> with. The service is named `keepercard-api`, but renaming it does not move the domain, so
> its URL stays `https://attestpay-api.onrender.com`. Only a new service, or a custom
> domain, would change the host — and recreating it would mean re-entering every secret.
> The dashboard is built against the real host, not the service name.

The blueprint is `render.yaml`. Non-secret KeeperHub values (workflow ids, wallet, the
dry-run gate) are declared there; anything `sync: false` must be set by hand.

### Set these in Render → your service → Environment

| Key | Value | Why |
|---|---|---|
| `KEEPERHUB_API_KEY` | your `kh_…` key | Without it every payment fails loudly with `keeperhub_not_configured` |
| `ATTESTPAY_ADMIN_TOKEN` | a fresh random string | **Never reuse a local dev token.** This is full admin over the API |
| `ATTESTPAY_MASTER_KEY` | existing value | Encrypts card secrets |
| `ATTESTPAY_PRIVY_APP_ID` | existing value | Must match the dashboard's build-time Privy app id, or every request 401s |

The workflow ids are already in `render.yaml`. Re-run
`bun run --cwd packages/server keeperhub:provision` only if you recreate the workflows;
it matches by name, so ids stay stable.

### Confirm it took

```bash
curl -s https://attestpay-api.onrender.com/health
curl -s https://attestpay-api.onrender.com/facilitator/supported | grep -o '"rail":"[^"]*"'
```

`"rail":"keeperhub"` means the execution layer is live. `"rail":"1shot-public-relayer"`
means `KEEPERHUB_API_KEY` did not reach the service.

The free plan sleeps, so the first request after idle can take ~50s and may look like a
timeout. Retry once before concluding anything is broken.

## 3. Health check

Run the doctor against the deployed configuration:

```bash
bun run --cwd packages/server keeperhub:doctor
```

It checks the key, the org wallet, chain support, wallet gas, every configured workflow,
the simulator and spend-cap headroom, and exits non-zero on anything that would break a
payment.

## Notes that have bitten us

- **Chain id must match on both sides.** The dashboard bakes it in at build time; the API
  reads `ATTESTPAY_CHAIN_ID` at boot. A mismatch produces delegations that cannot be
  redeemed, and the failure surfaces far from its cause.
- **Free-tier Render has no persistent disk.** `/data` resets on every deploy and whenever
  the instance sleeps, which loses cards, delegations and the proof queue. Attach a disk
  for anything beyond a demo.
- **Gas sponsorship covers fees, not assets.** The KeeperHub wallet needs the tokens a
  payment moves; it does not need native gas on the supported chains.
- **`autoDeploy` follows the repo the Render service is wired to.** If pushes are not
  triggering builds, check that the service points at this repository and branch.
