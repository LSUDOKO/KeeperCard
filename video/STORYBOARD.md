# KeeperCard × KeeperHub — demo video storyboard

Target length: ~3:20 · 1920×1080 · 30 fps · voice-over + captions + music/SFX.

Everything in the demo sections is real footage of the live product
(https://keepercard-dashboard.adoranto737.workers.dev, https://app.keeperhub.com,
https://base-sepolia.blockscout.com) and a real payment made during recording.
Nothing is mocked. The product is **KeeperCard**; **KeeperHub** is the execution layer that
runs every payment, so both brands appear throughout.

| Time | Section | On screen | Source |
|---|---|---|---|
| 0:00–0:20 | **Problem** | An agent needs to pay for an API. Door 1: hand it the wallet → the balance drains through a retry loop and a hallucinated address. Door 2: a human approving every payment, forever. | Remotion motion graphics |
| 0:20–0:36 | **Meet KeeperCard** | Logo reveal. "Give your agent a card, not your keys." The split: KeeperCard decides *what may be spent*; KeeperHub *moves the money*. A tangle of relayer / nonces / retries collapses into two clean boxes. | Remotion |
| 0:36–0:50 | **The card** | Dashboard: a real card, $5 lifetime limit, expiry, active. Zoom on terms. Connect Agent → one URL any MCP client can use (URL blurred). | Footage: dashboard |
| 0:56–1:28 | **The payment** | A real Claude Code session with the card's MCP endpoint: asked to pay for API credits it calls `keeperhub_dry_run` (KeeperHub simulates the exact calldata, returns plan id, gas, risk), then `pay(plan_id)` → confirmed with a transaction hash. Asked for 20 USDC, the card refuses (`over_lifetime_limit`). | Footage: terminal |
| 1:20–1:45 | **Inside KeeperHub** | KeeperHub's own UI: the run appears, every step green, "Gas sponsored". The runs table: payment → receipt anchor → event watcher started by the chain. | Footage: app.keeperhub.com |
| 1:45–2:05 | **Proof** | Execution console: timeline with payment linked to its on-chain receipt; treasury read live through KeeperHub. Blockscout: the transaction, two USDC transfers in one atomic tx. | Footage: console + explorer |
| 2:05–2:30 | **Features** | Quick cuts with callouts: *Dry-run gate* · *Risk-guarded workflow* (KeeperHub canvas with the Condition node) · *Scheduled treasury monitor* (runs every 10 min) · *Event-triggered receipts* · *Freeze / revoke* (real freeze then unfreeze) · *Sub-cards*. | Footage + Remotion callouts |
| 2:30–2:50 | **How it works** | Animated architecture: Agent → MCP → KeeperCard API → KeeperHub (simulate · workflow · Turnkey signing · gas sponsorship) → Base Sepolia (DelegationManager · USDC · PaymentAnchor) → event → KeeperHub Event trigger. Stack strip: Next.js on Cloudflare Workers · Bun + Hono on Render · SQLite · Privy · viem · ERC-7710 / EIP-7702 · Chainlink · OpenTelemetry. | Remotion |
| 2:50–3:00 | **Impact + close** | Without: keys in the agent, manual approvals, hand-rolled relayers. With: scoped cards, automated execution, three independent records. Closing card: KeeperCard · built on KeeperHub. | Remotion |

## Rules applied

- No feature shown that is not live. Not shown: mainnet, x402 / fiat settlement runs, a risk *refusal*.
- The card secret in the Connect Agent modal is blurred on screen before capture.
- No localhost. No API keys. The only address shown is the user's own test wallet.
