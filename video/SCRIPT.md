# Voice-over script

Voice: confident, unhurried, technical but plain. Each block is one scene; the audio for
each block is generated separately (`audio/voice.py`) so the picture is cut to the voice.

## 01 · problem
An AI agent that can pay for things is useful. An AI agent holding your private key is a liability.
Give it the wallet, and one retry loop or one hallucinated address drains the balance — there is no limit and no undo.
Keep a human approving every payment, and you no longer have an agent.

## 02 · meet
Meet KeeperCard. Give your agent a card, not your keys.
A card is a scoped, revocable delegation from your own wallet — a budget, an expiry, the merchants it may pay.
KeeperCard decides what may be spent. KeeperHub moves the money.

## 03 · card
A card is issued from the dashboard in about a minute. This one is real, on Base Sepolia: a five-dollar lifetime limit, enforced on-chain. Funds stay in the owner's wallet until the moment of payment.
Connect Agent gives you one URL. Any agent that speaks MCP plugs it in.

## 04 · payment
Here, Claude Code has the card connected over MCP. Asked to pay for API credits, it dry-runs first: KeeperHub simulates the exact calldata and returns a plan, a gas estimate and a risk read. Nothing has touched the chain.
Then it pays. The same bytes go to a KeeperHub workflow, and seconds later the payment is confirmed — with a transaction hash.
Asked for twenty dollars, the card refuses: over its lifetime limit, and nothing was attempted on-chain.

## 05 · keeperhub
This is KeeperHub's own view of that payment. Every step of the workflow succeeded, and the gas was sponsored — the card owner paid no gas.
Then KeeperHub kept going on its own: a second workflow wrote an on-chain receipt, and the chain itself fired a third one that watches for receipts.

## 06 · proof
Back in KeeperCard, the execution console links each payment to its receipt, and reads the treasury live through KeeperHub.
On an independent explorer, the transaction shows what a card payment really is: two USDC transfers in one atomic transaction — the merchant, and the fee.

## 07 · features
Every payment must be dry-run first. High-value payments run a guarded workflow, where KeeperHub's risk check is a condition the write cannot bypass.
A scheduled workflow watches the wallets every ten minutes. Receipts are event-triggered. And when you freeze a card, the agent is refused instantly — revoke, and it is dead on-chain.

## 08 · architecture
The agent talks to KeeperCard over MCP. KeeperCard checks the card's terms and hands KeeperHub the calldata. KeeperHub simulates it, runs the workflow, signs with Turnkey, sponsors the gas, and redeems the delegation on Base. The receipt event flows back through KeeperHub's own trigger.
Next.js on Cloudflare, Bun on Render, Chainlink feeds, ERC-7710 delegations — and nine KeeperHub workflows defined as code.

## 09 · close
Without KeeperCard: keys in the agent, and payment infrastructure you build yourself.
With it: a card the chain enforces, execution KeeperHub owns, and three independent records of every payment.
KeeperCard. Built on KeeperHub.
