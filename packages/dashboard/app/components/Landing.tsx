"use client";

// The landing page: a creative studio's moodboard for a payments product. One
// centered hero (badge, display headline with a highlighted word, subhead, CTA
// stack, backed-by strip), then sections that breathe at 80px: how a payment
// works, the sticky-note feature grid, the connect block, a yellow closing band, a short footer.
// Everything here is real copy about the real product; nothing links to "#".

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, type Variants } from "motion/react";
import { usePrivy } from "@privy-io/react-auth";
import { Logo } from "./Logo";
import { ThemeToggle } from "./Theme";
import { SketchArrow, SketchCircle, SketchLoop, SketchStar } from "./Sketch";

const rise: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] } },
};
const stagger: Variants = { hidden: {}, show: { transition: { staggerChildren: 0.08 } } };

/** The floating pill nav, shared by the landing page and the public pages. */
export function PublicNav({ links = true }: { links?: boolean }) {
  const path = usePathname();
  const { authenticated, ready } = usePrivy();
  const dash = ready && authenticated ? "Open dashboard" : "Sign in";
  return (
    <div className="lpnav-wrap">
      <nav className="lpnav" aria-label="Primary">
        <Logo href="/" />
        {links && (
          <div className="navlinks">
            <a className="navlink" href="/#how">
              How it works
            </a>
            <a className="navlink" href="/#features">
              Product
            </a>
            <a className="navlink" href="/#connect">
              Connect
            </a>
            <Link className={`navlink${path?.startsWith("/docs") ? " on" : ""}`} href="/docs">
              Docs
            </Link>
          </div>
        )}
        <div className="ctas">
          <ThemeToggle />
          <Link className="abtn outline" href="/docs">
            Docs
          </Link>
          <Link className="abtn primary arrow" href="/app" data-testid="landing-open">
            {dash}
          </Link>
        </div>
      </nav>
    </div>
  );
}

export function Landing() {
  return (
    <div className="lp">
      <PublicNav />

      {/* ---- hero ---- */}
      <header className="lphero lpwrap">
        <SketchArrow className="sk1" size={150} />
        <SketchStar className="sk2" size={70} />
        <SketchLoop className="sk3" size={170} />
        <SketchCircle className="sk4" size={100} />
        <motion.div variants={stagger} initial="hidden" animate="show">
          <motion.span className="lpbadge" variants={rise}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M9 1.5 3.5 9h4l-1 5.5L12 7H8z" />
            </svg>
            Agentic spending cards · live on Base
          </motion.span>
          <motion.h1 className="lph1" variants={rise}>
            Give your agent a <span className="hl wash">card</span>, not your keys.
          </motion.h1>
          <motion.p className="lpsub" variants={rise}>
            Issue a scoped, revocable spending card from your wallet. Any AI agent plugs it in over MCP and pays
            within your limits — no keys, no gas, dead the moment you revoke. Every confirmed payment gets an
            on-chain receipt written by KeeperHub.
          </motion.p>
          <motion.div className="lpctas" variants={rise}>
            <Link className="abtn primary big arrow" href="/app" data-testid="landing-cta">
              Issue a card
            </Link>
            <Link className="abtn pastel big" href="/docs">
              Read the docs
            </Link>
          </motion.div>
          <motion.p className="lpreassure" variants={rise}>
            sign in with email or Google · no seed phrase, no card on file.
          </motion.p>
          <motion.div className="lpbacked" variants={rise} aria-label="Built on">
            <span className="bl">Built on:</span>
            <span>Base</span>
            <span>ERC-7710</span>
            <span>EIP-7702</span>
            <span>x402</span>
            <span>KeeperHub</span>
            <span>MCP</span>
            <span>SigNoz</span>
          </motion.div>
        </motion.div>
      </header>

      {/* ---- how a payment works ---- */}
      <Section id="how" eyebrow="How a payment works" title={<>Three moves, and the agent never touches money.</>}>
        <div className="steps">
          {[
            {
              n: "01",
              t: "You issue",
              p: (
                <>
                  Set the terms — budget per period, per-payment cap, merchant allowlist, expiry — or draft them in
                  plain language. Your wallet <span className="hl">signs the delegation</span> in the browser; the
                  server stores it beside a fresh agent key that holds nothing.
                </>
              ),
            },
            {
              n: "02",
              t: "The agent plugs in",
              p: (
                <>
                  One <code>claude mcp add</code>, a Cursor deeplink, or a pasted connector URL. The tool list is the
                  permission surface: a pay-only card never sees <code>execute</code>.
                </>
              ),
            },
            {
              n: "03",
              t: "It pays, with a receipt",
              p: (
                <>
                  Each <code>pay</code> is checked against the terms, redeemed gaslessly on Base in USDC from your
                  wallet, then KeeperHub writes an <span className="hl">on-chain receipt</span> (PaymentAnchor) on Base Sepolia.
                </>
              ),
            },
          ].map((s) => (
            <motion.div key={s.n} className="step" variants={rise}>
              <span className="sn">{s.n}</span>
              <h3>{s.t}</h3>
              <p>{s.p}</p>
            </motion.div>
          ))}
        </div>
      </Section>

      {/* ---- features as sticky notes ---- */}
      <Section id="features" eyebrow="What a card can do" title={<>Everything a card should be, <span className="hl">rebuilt</span> for agents.</>}>
        <div className="notes">
          <Note k="Scope" tone="mint" title="Terms the chain enforces" foot="ERC-7710 caveats · Base mainnet">
            Period budget, lifetime cap, per-payment max, merchant allowlist, expiry, usage count. The enforcers check
            every one again on-chain, so the server can never approve what the chain would reject.
          </Note>
          <Note k="Kill switch" title="Revoke, and it's dead" foot="server-side instantly · on-chain underneath">
            Freeze or revoke a card — or its whole sub-card tree — and every payment stops. Sub-cards nest tighter terms
            for sub-agents and die with their parent.
          </Note>
          <Note k="Receipt" tone="teal" title="A receipt for every payment" foot="PaymentAnchor · KeeperHub · Base Sepolia">
            Every confirmed payment gets an on-chain receipt (PaymentAnchor) written by KeeperHub on Base Sepolia, so
            anyone can check what was paid, to whom, and when.
          </Note>
          <Note k="Rails" title="Pays the open web" foot="x402 · Visa (test mode) · contract calls">
            <code>paid_fetch</code> settles HTTP 402 challenges automatically; a fiat lane buys over Visa rails; contract
            cards run scoped swaps and approvals atomically.
          </Note>
          <Note k="Operate" title="Built to run, not to demo" foot="webhooks · teams · audit · SDK">
            Signed webhooks with retries, roles over shared cards, a CSV-exportable audit log, budget alerts, and a
            typed SDK. Every hop traced into SigNoz.
          </Note>
        </div>
      </Section>

      {/* ---- connect ---- */}
      <Section id="connect" eyebrow="Connecting an agent" title={<>One line in any harness.</>}>
        <div className="lpsplit rev" style={{ marginTop: 32 }}>
          <div>
            <pre className="lpcode">{`# Lane A · secret in the URL path
claude mcp add --transport http remit `}<span className="y">https://&lt;host&gt;/c/&lt;card-secret&gt;/mcp</span>{`

# Lane C · OAuth 2.1, card-picker consent
claude mcp add --transport http remit https://<host>/mcp
`}<span className="c"># the client discovers the OAuth lane on the 401, registers itself,
# and opens a browser: you pick which card to grant.</span></pre>
            <div className="lpharness">
              {["Claude Code", "claude.ai", "Cursor", "VS Code", "Codex", "Gemini CLI", "Goose", "Windsurf", "ChatGPT", "OpenClaw", "Amp", "Droid"].map((h) => (
                <span key={h}>{h}</span>
              ))}
            </div>
          </div>
          <div>
            <p className="lplede">
              The card <em>is</em> the connection. Behind the URL sits a scoped delegation; the agent holds the card,
              never the money. Rotate the secret from the dashboard and the old URL dies instantly.
            </p>
            <p className="lplede" style={{ marginTop: 12 }}>
              Refusals are typed — <code>over_period_limit</code>, <code>merchant_not_allowed</code>,{" "}
              <code>price_exceeds_max</code> — so an agent can relay them honestly instead of guessing.
            </p>
          </div>
        </div>
      </Section>

      {/* ---- closing band ---- */}
      <div className="lpwrap">
        <motion.div className="lpband" variants={rise} initial="hidden" whileInView="show" viewport={{ once: true, margin: "-60px" }}>
          <SketchArrow className="sk" size={140} />
          <h2 className="lph2">Your agent&apos;s first card takes about a minute.</h2>
          <p className="lplede">Real USDC on Base mainnet. The only simulated leg is the Visa rail, labelled wherever it appears.</p>
          <div className="lpctas">
            <Link className="abtn primary big arrow" href="/app">
              Open the dashboard
            </Link>
            <Link className="abtn big" href="/docs">
              Read the docs
            </Link>
          </div>
        </motion.div>

        <footer className="lpfoot">
          <Logo size="sm" />
          <nav aria-label="Footer">
            <Link href="/docs">Docs</Link>
            <a href="https://github.com/LSUDOKO/KeeperCard" target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href="https://github.com/LSUDOKO/KeeperCard/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer">
              Changelog
            </a>
            <a href="https://github.com/LSUDOKO/KeeperCard/blob/main/SECURITY.md" target="_blank" rel="noreferrer">
              Security
            </a>
            <a href="https://github.com/LSUDOKO/KeeperCard/blob/main/LICENSE" target="_blank" rel="noreferrer">
              License
            </a>
          </nav>
          <span className="fine">Base mainnet · receipts on Base Sepolia via KeeperHub · built for the SigNoz hackathon</span>
        </footer>
      </div>
    </div>
  );
}

function Section({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: React.ReactNode; children: React.ReactNode }) {
  return (
    <motion.section
      id={id}
      className="lpsec lpwrap"
      variants={stagger}
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, margin: "-80px" }}
      style={{ scrollMarginTop: 96 }}
    >
      <motion.div className="lpeyebrow" variants={rise}>
        {eyebrow}
      </motion.div>
      <motion.h2 className="lph2" variants={rise}>
        {title}
      </motion.h2>
      {children}
    </motion.section>
  );
}

function Note({ k, tone, title, foot, children }: { k: string; tone?: "mint" | "teal" | "blush" | "yellow"; title: string; foot: string; children: React.ReactNode }) {
  return (
    <motion.article className={`note${tone ? ` ${tone}` : ""}`} variants={rise}>
      <span className="nk">{k}</span>
      <h3>{title}</h3>
      <p>{children}</p>
      <span className="nfoot">{foot}</span>
    </motion.article>
  );
}
