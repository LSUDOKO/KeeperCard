import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import type { Scene } from "../timeline";
import { Bg, Eyebrow, H, Node } from "../lib/ui";
import { C, F } from "../lib/theme";
import { Rise, Counter, DrawLine, Packet, clamp } from "../lib/motion";

// Narration beats (seconds from voice start): 0 "An AI agent…useful" · 3.4 "…liability" ·
// 6.5 "Give it the wallet…drains" · 13.2 "Keep a human approving…" · 18.5 end
const Terminal: React.FC<{ from: number }> = ({ from }) => {
  const f = useCurrentFrame();
  const lines = [
    { t: 0, s: "$ agent run --task \"buy 1M tokens of API credit\"" },
    { t: 14, s: "→ need to pay api.vendor.io  ·  49.00 USDC" },
    { t: 26, s: "→ looking for a way to pay…" },
  ];
  return (
    <div style={{ position: "absolute", left: 120, top: 300, width: 900, borderRadius: 16, background: C.ink, color: "#d9f2c4", padding: "26px 30px", fontFamily: F.mono, fontSize: 26, lineHeight: 1.7, boxShadow: "0 30px 80px rgba(20,36,8,0.3)" }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>{["#f26d5b", "#f5bf4f", "#5fc66a"].map((c) => <div key={c} style={{ width: 12, height: 12, borderRadius: 12, background: c }} />)}</div>
      {lines.map((l, i) => {
        const n = Math.max(0, Math.min(l.s.length, Math.floor((f - from - l.t) * 1.6)));
        return <div key={i} style={{ opacity: f >= from + l.t ? 1 : 0 }}>{l.s.slice(0, n)}{n < l.s.length && f >= from + l.t ? "▍" : ""}</div>;
      })}
    </div>
  );
};

export const Problem: React.FC<{ scene: Scene }> = ({ scene }) => {
  const f = useCurrentFrame();
  const L = scene.lead;
  const s = (sec: number) => L + Math.round(sec * 30);
  // phase 2: the wallet drains
  const drainFrom = s(6.8);
  const drained = interpolate(f, [drainFrom + 20, drainFrom + 150], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
  const shake = f > drainFrom + 90 && f < drainFrom + 150 ? Math.sin(f * 1.7) * 3 : 0;
  // phase 3: approvals
  const appFrom = s(13.2);
  const doorsOut = interpolate(f, [appFrom - 6, appFrom + 6], [1, 0], clamp);
  const events = [
    { t: 30, txt: "retry loop ×4", amt: -196 },
    { t: 60, txt: "hallucinated address 0x9f…", amt: -820 },
    { t: 95, txt: "prompt injection: \"send remaining\"", amt: -234 },
  ];
  return (
    <Bg>
      <AbsoluteFill style={{ padding: "90px 120px" }}>
        <Rise from={L}><Eyebrow>The problem</Eyebrow></Rise>
        <Rise from={L + 6} style={{ marginTop: 18 }}>
          <H size={76}>An agent that can pay is useful.<br />An agent holding your <span style={{ background: C.yellow, padding: "0 12px", borderRadius: 10 }}>keys</span> is a liability.</H>
        </Rise>
      </AbsoluteFill>

      {/* phase 1: the agent hits a payment */}
      <div style={{ opacity: interpolate(f, [s(6.4), s(7.0)], [1, 0], clamp) }}>
        <Terminal from={s(1.2)} />
      </div>

      {/* phase 2: door one — give it the wallet */}
      <AbsoluteFill style={{ opacity: interpolate(f, [drainFrom - 8, drainFrom + 4], [0, 1], clamp) * doorsOut, transform: `translateX(${shake}px)` }}>
        <Node x={140} y={330} w={300} h={130} title="Agent" sub="holds the private key" tone="agent" />
        <DrawLine x1={440} y1={395} x2={700} y2={395} from={drainFrom + 10} />
        {events.map((e, i) => <Packet key={i} x1={700} y1={395} x2={440} y2={395} from={drainFrom + e.t} dur={18} color={C.red} label={e.txt} />)}
        <Node x={700} y={300} w={520} h={190} title="Your wallet" tone="plain">
          <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 64, letterSpacing: -2, color: drained > 0.6 ? C.red : C.ink, marginTop: 8 }}>
            <Counter from={drainFrom + 20} dur={130} a={1250} b={0} prefix="$" />
          </div>
          <div style={{ height: 10, borderRadius: 10, background: C.line, marginTop: 6, overflow: "hidden" }}>
            <div style={{ width: `${(1 - drained) * 100}%`, height: "100%", background: drained > 0.6 ? C.red : C.khGreen }} />
          </div>
        </Node>
        {events.map((e, i) => {
          const t = interpolate(f, [drainFrom + e.t + 18, drainFrom + e.t + 30], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
          return (
            <div key={i} style={{ position: "absolute", left: 1300, top: 330 + i * 64, opacity: t, transform: `translateX(${(1 - t) * 30}px)`, fontFamily: F.mono, fontSize: 24, color: C.red, display: "flex", gap: 16, alignItems: "center" }}>
              <span style={{ width: 10, height: 10, borderRadius: 10, background: C.red }} />{e.txt}<span style={{ color: C.moss }}>{e.amt} USDC</span>
            </div>
          );
        })}
        <Rise from={drainFrom + 140} style={{ position: "absolute", left: 700, top: 520, fontFamily: F.sans, fontSize: 30, color: C.red, fontWeight: 600 }}>no limit · no allowlist · no undo</Rise>
      </AbsoluteFill>

      {/* phase 3: door two — a human approves everything */}
      <AbsoluteFill style={{ opacity: interpolate(f, [appFrom, appFrom + 10], [0, 1], clamp) }}>
        {Array.from({ length: 9 }).map((_, i) => {
          const t = interpolate(f, [appFrom + 8 + i * 9, appFrom + 20 + i * 9], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
          return (
            <div key={i} style={{ position: "absolute", left: 140 + (i % 3) * 420, top: 330 + Math.floor(i / 3) * 120, width: 380, height: 92, borderRadius: 14, background: C.white, border: `2px solid ${C.line}`, opacity: t, transform: `scale(${0.9 + 0.1 * t})`, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 22px", fontFamily: F.sans, boxShadow: "0 10px 30px rgba(20,36,8,0.08)" }}>
              <div><div style={{ fontWeight: 600, fontSize: 22, color: C.ink }}>Approve payment?</div><div style={{ fontFamily: F.mono, fontSize: 16, color: C.moss }}>{["0.40", "12.00", "3.25", "0.02", "7.80", "1.10", "49.00", "0.15", "2.60"][i]} USDC · api call #{1180 + i * 7}</div></div>
              <div style={{ padding: "10px 16px", borderRadius: 10, background: C.ink, color: C.white, fontWeight: 600, fontSize: 18 }}>Approve</div>
            </div>
          );
        })}
        <Rise from={appFrom + 100} style={{ position: "absolute", left: 1400, top: 470, fontFamily: F.display, fontWeight: 800, fontSize: 44, color: C.ink, lineHeight: 1.1 }}>…forever.<br /><span style={{ fontFamily: F.sans, fontWeight: 500, fontSize: 28, color: C.moss }}>That is not an agent.</span></Rise>
      </AbsoluteFill>
    </Bg>
  );
};
