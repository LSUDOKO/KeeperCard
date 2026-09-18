import React from "react";
import { AbsoluteFill, Audio, interpolate, staticFile, useCurrentFrame } from "remotion";
import type { Scene } from "../timeline";
import { Bg, Eyebrow, Node, Chip } from "../lib/ui";
import { C, F } from "../lib/theme";
import { Rise, DrawLine, Packet, Check, clamp } from "../lib/motion";

// beats (s): 0 "The agent talks to KeeperCard over MCP" · 2.6 "KeeperCard checks the card's terms and
// hands KeeperHub the calldata" · 6.6 "KeeperHub simulates it, runs the workflow, signs with Turnkey,
// sponsors the gas, and redeems the delegation on Base" · 14.4 "The receipt event flows back…"
// · 18.4 "Next.js on Cloudflare, Bun on Render, Chainlink feeds, ERC-7710 — and nine workflows as code"
export const Architecture: React.FC<{ scene: Scene }> = ({ scene }) => {
  const f = useCurrentFrame();
  const L = scene.lead;
  const s = (sec: number) => L + Math.round(sec * 30);
  const nodes = {
    agent: { x: 110, y: 430, w: 250, h: 130 },
    kc: { x: 520, y: 400, w: 330, h: 190 },
    kh: { x: 1010, y: 360, w: 360, h: 270 },
    chain: { x: 1530, y: 400, w: 290, h: 190 },
  };
  const mid = (n: { x: number; y: number; w: number; h: number }) => ({ x: n.x + n.w / 2, y: n.y + n.h / 2 });
  const A = mid(nodes.agent), K = mid(nodes.kc), H = mid(nodes.kh), B = mid(nodes.chain);
  const khSteps = [
    { t: 7.0, s: "simulate exact calldata" },
    { t: 8.6, s: "run workflow" },
    { t: 10.0, s: "sign with Turnkey" },
    { t: 11.2, s: "sponsor gas" },
    { t: 12.4, s: "redeemDelegations()" },
  ];
  const stackFrom = s(18.6);
  const stackY = interpolate(f, [stackFrom, stackFrom + 14], [60, 0], clamp);
  const stack = ["Next.js · Cloudflare Workers", "Bun · Hono · Render", "SQLite", "Privy auth", "viem", "ERC-7710 · EIP-7702", "Chainlink feeds", "OpenTelemetry", "9 KeeperHub workflows as code"];
  return (
    <Bg tone="navy">
      <Audio src={staticFile("sfx/tick.wav")} volume={0.3} startFrom={0} />
      <div style={{ position: "absolute", left: 120, top: 90 }}>
        <Rise from={L}><Eyebrow light>How it works</Eyebrow></Rise>
        <Rise from={L + 6}><div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 56, color: C.white, letterSpacing: -1.5, marginTop: 10 }}>One payment, end to end</div></Rise>
      </div>

      {/* nodes */}
      <Rise from={s(0)}><Node {...nodes.agent} title="AI agent" sub="any MCP client" tone="agent" /></Rise>
      <Rise from={s(0.9)}><Node {...nodes.kc} title="KeeperCard" sub="Bun · Hono · MCP server" tone="kc"><div style={{ fontFamily: F.sans, fontSize: 17, marginTop: 8, color: C.forest }}>checks terms · builds calldata · dry-run gate</div></Node></Rise>
      <Rise from={s(4.4)}>
        <Node {...nodes.kh} title="KeeperHub" sub="execution layer" tone="kh" glow={f > s(6.6) && f < s(14.4)}>
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
            {khSteps.map((st) => {
              const on = f >= s(st.t);
              return (
                <div key={st.s} style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: F.mono, fontSize: 16, color: on ? C.white : "rgba(255,255,255,0.35)" }}>
                  <div style={{ width: 16, height: 16 }}>{on && <Check from={s(st.t)} size={16} />}</div>{st.s}
                </div>
              );
            })}
          </div>
        </Node>
      </Rise>
      <Rise from={s(12.0)}><Node {...nodes.chain} title="Base Sepolia" sub="DelegationManager · USDC" tone="chain"><div style={{ fontFamily: F.mono, fontSize: 15, marginTop: 8, opacity: 0.85 }}>PaymentAnchor receipts</div></Node></Rise>

      {/* links and packets */}
      <DrawLine x1={nodes.agent.x + nodes.agent.w} y1={A.y} x2={nodes.kc.x} y2={K.y} from={s(0.4)} color={C.khGreen} />
      <Packet x1={nodes.agent.x + nodes.agent.w} y1={A.y} x2={nodes.kc.x} y2={K.y} from={s(1.0)} dur={18} label="dry_run / pay" />
      <DrawLine x1={nodes.kc.x + nodes.kc.w} y1={K.y} x2={nodes.kh.x} y2={H.y} from={s(4.6)} color={C.khGreen} />
      <Packet x1={nodes.kc.x + nodes.kc.w} y1={K.y} x2={nodes.kh.x} y2={H.y} from={s(5.2)} dur={18} label="calldata · digest" />
      <DrawLine x1={nodes.kh.x + nodes.kh.w} y1={H.y} x2={nodes.chain.x} y2={B.y} from={s(12.2)} color={C.khGreen} />
      <Packet x1={nodes.kh.x + nodes.kh.w} y1={H.y} x2={nodes.chain.x} y2={B.y} from={s(12.6)} dur={18} label="tx · sponsored" color={C.khGreen} />
      {/* receipt event back to KeeperHub's own trigger */}
      <DrawLine x1={B.x} y1={nodes.chain.y + nodes.chain.h} x2={H.x} y2={nodes.kh.y + nodes.kh.h} from={s(14.4)} color={"#3b82f6"} />
      <Packet x1={B.x} y1={nodes.chain.y + nodes.chain.h} x2={H.x} y2={nodes.kh.y + nodes.kh.h} from={s(15.0)} dur={22} label="PaymentAnchored → Event trigger" color={"#60a5fa"} />
      <Rise from={s(16.4)} style={{ position: "absolute", left: 1010, top: 690, fontFamily: F.sans, fontSize: 20, color: "rgba(255,255,255,0.7)" }}>the chain starts the run — not KeeperCard</Rise>

      {/* stack strip */}
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 150, display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap", padding: "0 120px", transform: `translateY(${stackY}px)`, opacity: interpolate(f, [stackFrom, stackFrom + 12], [0, 1], clamp) }}>
        {stack.map((t, i) => {
          const o = interpolate(f, [stackFrom + i * 3, stackFrom + i * 3 + 8], [0, 1], clamp);
          return <span key={t} style={{ opacity: o }}><Chip tone={i === stack.length - 1 ? "green" : "ghost"} size={20}>{t}</Chip></span>;
        })}
      </div>
    </Bg>
  );
};
