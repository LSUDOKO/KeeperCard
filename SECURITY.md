# Security Policy

KeeperCard issues scoped, revocable spending authority to AI agents and writes payment
records to public chains. A vulnerability here can move other people's money or put a
false record on a chain, so please treat reports accordingly.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting:
[Report a vulnerability](https://github.com/LSUDOKO/KeeperCard/security/advisories/new).

Please include what you can of: affected component (contract, engine, server, dashboard),
the chain and address if on-chain, a reproduction, and the impact you believe it has.

You can expect an acknowledgement within 72 hours and an assessment within 7 days. If a
fix is warranted we will agree disclosure timing with you before publishing.

## Scope

In scope:

- `contracts/` — `PaymentAnchor`
- `packages/engine` — delegation compilation, spend authorisation, the KeeperHub execution lane
- `packages/server` — REST API, MCP tools, OAuth, webhooks
- `packages/dashboard` — the issuance flow, in particular anything that signs

Out of scope:

- The testnet deployments' funds. They are testnet funds, deliberately.
- Rate limits or availability of third-party RPCs, KeeperHub, or Stripe.
- Anything requiring a compromised operator key or KeeperHub organisation. The executing
  wallet is trusted by design; see the trust model below.

## Trust model, stated plainly

A card is an ERC-7710 delegation: the limits are enforced on-chain by caveat enforcers,
not by the KeeperCard server. KeeperHub executes every payment, and a payment that was
not dry-run first is refused.

Every confirmed payment gets an on-chain receipt: KeeperHub calls
`PaymentAnchor.anchorPayment` on the same chain the payment settled on. A receipt
establishes that **`anchoredBy` claimed this payment with exactly those values at that
block**, immutably — a second anchor for the same `(sourceChainId, sourceTxHash)` reverts.
It does **not** by itself establish that the payment happened. Anchoring is permissionless,
so every receipt records the source transaction hash and the anchorer's address: anyone
can open the transaction on the same chain and check it, and consumers decide which
anchorers they trust.

A report showing that a card can be made to spend **outside** its signed limits, that a
payment can execute without a dry run, or that a receipt can be rewritten or duplicated,
is a critical finding and exactly what we want to hear about.

## Supported versions

The `main` branch is the supported version. This is hackathon-stage software on testnets;
it has not been audited and should not custody real funds.
