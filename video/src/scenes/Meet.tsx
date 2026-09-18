import React from "react";
import { AbsoluteFill, Audio, Easing, interpolate, staticFile, useCurrentFrame } from "remotion";
import type { Scene } from "../timeline";
import { Bg, Eyebrow, H, KCMark, KHMark, P, Chip } from "../lib/ui";
import { C, F } from "../lib/theme";
import { Rise, useSpring, clamp, DrawLine, Packet } from "../lib/motion";

// beats: 0 "Meet KeeperCard" · 1.6 "Give your agent a card, not your keys" · 5.0 "A card is a
// scoped, revocable delegation… budget, expiry, merchants" · 11.4 "KeeperCard decides… KeeperHub moves"
export const Meet: React.FC<{ scene: Scene }> = ({ scene }) => {
  const f = useCurrentFrame();
  const L = scene.lead;
  const s = (sec: number) => L + Math.round(sec * 30);
  const logo = useSpring(L - 10, { damping: 13, stiffness: 110 });
  const tangleOut = interpolate(f, [L - 24, L - 4], [1, 0], clamp);
  const splitFrom = s(11.2);
  const heroOut = interpolate(f, [splitFrom - 8, splitFrom + 4], [1, 0], clamp);
  const cardIn = interpolate(f, [s(5.0), s(5.6)], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const terms = [
    { k: "budget", v: "$5.00 lifetime", t: 6.4 },
    { k: "expires", v: "Oct 17 · 30 days", t: 7.6 },
    { k: "merchants", v: "allowlist · optional", t: 8.6 },
    { k: "revocable", v: "freeze · revoke · nuke", t: 9.6 },
  ];
  return (
    <Bg>
      <Audio src={staticFile("sfx/reveal.wav")} volume={0.5} startFrom={0} />
      {/* the tangle collapsing (carried over from the problem) */}
      <AbsoluteFill style={{ opacity: tangleOut, transform: `scale(${0.9 + 0.1 * tangleOut})` }}>
        {["relayer", "nonces", "gas", "retries", "stuck tx", "approvals", "keys", "audit"].map((w, i) => {
          const a = (i / 8) * Math.PI * 2;
          return <div key={w} style={{ position: "absolute", left: 960 + Math.cos(a) * 340 - 60, top: 540 + Math.sin(a) * 180 - 20, fontFamily: F.mono, fontSize: 24, color: C.moss, padding: "8px 14px", border: `1.5px dashed ${C.moss}`, borderRadius: 10, transform: `rotate(${(i % 3) * 4 - 4}deg)` }}>{w}</div>;
        })}
      </AbsoluteFill>

      {/* hero */}
      <AbsoluteFill style={{ opacity: heroOut, alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 22, transform: `translateY(${-40 * cardIn}px)` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 26, transform: `scale(${logo})` }}>
            <KCMark size={120} />
            <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 112, letterSpacing: -4, color: C.ink }}>KeeperCard</div>
          </div>
          <Rise from={s(1.5)}><H size={56} style={{ textAlign: "center" }}>Give your agent a <span style={{ background: C.yellow, padding: "0 14px", borderRadius: 12 }}>card</span>, not your keys.</H></Rise>
          <Rise from={s(1.9)}><P size={28} style={{ textAlign: "center" }}>Spending cards for AI agents · built on KeeperHub</P></Rise>
        </div>

        {/* the card, with its terms */}
        <div style={{ position: "absolute", left: 960 - 330, top: 640, width: 660, opacity: cardIn, transform: `translateY(${(1 - cardIn) * 40}px)` }}>
          <div style={{ borderRadius: 22, background: "linear-gradient(135deg, #fffdf2 0%, #fff8c9 60%, #e9f5d2 100%)", border: `2px solid ${C.ink}`, padding: "22px 28px", boxShadow: "0 30px 80px rgba(20,36,8,0.22)", fontFamily: F.sans }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontFamily: F.display, fontWeight: 800, fontSize: 30, color: C.ink }}>agent card</span>
              <Chip tone="ink" size={16}>ERC-7710 delegation</Chip>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 24px", marginTop: 18 }}>
              {terms.map((t) => {
                const o = interpolate(f, [s(t.t), s(t.t) + 10], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
                return (
                  <div key={t.k} style={{ opacity: o, transform: `translateY(${(1 - o) * 10}px)` }}>
                    <div style={{ fontFamily: F.mono, fontSize: 15, letterSpacing: 1.5, textTransform: "uppercase", color: C.moss }}>{t.k}</div>
                    <div style={{ fontWeight: 600, fontSize: 24, color: C.ink }}>{t.v}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </AbsoluteFill>

      {/* the split */}
      <AbsoluteFill style={{ opacity: 1 - heroOut }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 150, textAlign: "center" }}>
          <Eyebrow>Two owners, one payment</Eyebrow>
        </div>
        <Rise from={splitFrom}>
          <div style={{ position: "absolute", left: 200, top: 330, width: 620, height: 380, borderRadius: 26, background: C.yellow, padding: 40, fontFamily: F.sans, boxShadow: "0 30px 80px rgba(20,36,8,0.18)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}><KCMark size={54} style={{ background: C.ink, color: C.yellow }} /><span style={{ fontFamily: F.display, fontWeight: 800, fontSize: 44, color: C.ink }}>KeeperCard</span></div>
            <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 40, color: C.ink, marginTop: 26, lineHeight: 1.1 }}>decides <em>what</em> may be spent</div>
            <div style={{ fontSize: 24, color: C.forest, marginTop: 14, lineHeight: 1.4 }}>caveats · budgets · sub-cards · freeze / revoke · the MCP surface an agent plugs into</div>
          </div>
        </Rise>
        <Rise from={splitFrom + 12}>
          <div style={{ position: "absolute", left: 1100, top: 330, width: 620, height: 380, borderRadius: 26, background: C.navy2, padding: 40, fontFamily: F.sans, boxShadow: "0 30px 80px rgba(20,36,8,0.28)", border: `3px solid ${C.khGreen}` }}>
            <KHMark size={54} light />
            <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 40, color: C.white, marginTop: 26, lineHeight: 1.1 }}>moves the money</div>
            <div style={{ fontSize: 24, color: "rgba(255,255,255,0.75)", marginTop: 14, lineHeight: 1.4 }}>dry runs · workflows · nonces · gas sponsorship · Turnkey signing · run history · chain reads</div>
          </div>
        </Rise>
        <DrawLine x1={820} y1={520} x2={1100} y2={520} from={splitFrom + 24} color={C.ink} />
        <Packet x1={820} y1={520} x2={1100} y2={520} from={splitFrom + 40} dur={22} color={C.khGreen} label="reviewed calldata" />
        <Packet x1={820} y1={520} x2={1100} y2={520} from={splitFrom + 75} dur={22} color={C.khGreen} />
      </AbsoluteFill>
    </Bg>
  );
};
