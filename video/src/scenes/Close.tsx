import React from "react";
import { AbsoluteFill, Audio, Easing, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import type { Scene } from "../timeline";
import { Bg, KCMark, KHMark, Eyebrow } from "../lib/ui";
import { C, F } from "../lib/theme";
import { Rise, useSpring, clamp } from "../lib/motion";

// beats: 0 "Without KeeperCard: keys in the agent, infra you build yourself" · 5.3 "With it: a card the
// chain enforces, execution KeeperHub owns, three records" · 12.2 "KeeperCard. Built on KeeperHub."
const Col: React.FC<{ from: number; title: string; items: string[]; bad?: boolean; x: number }> = ({ from, title, items, bad, x }) => {
  const f = useCurrentFrame();
  return (
    <div style={{ position: "absolute", left: x, top: 300, width: 720 }}>
      <Rise from={from}><div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 44, color: bad ? "rgba(255,255,255,0.55)" : C.white, letterSpacing: -1 }}>{title}</div></Rise>
      {items.map((it, i) => {
        const t = interpolate(f, [from + 10 + i * 12, from + 22 + i * 12], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
        return (
          <div key={it} style={{ display: "flex", alignItems: "center", gap: 18, marginTop: 22, opacity: t, transform: `translateX(${(1 - t) * (bad ? -20 : 20)}px)` }}>
            <div style={{ width: 34, height: 34, borderRadius: 34, display: "grid", placeItems: "center", background: bad ? "rgba(229,72,77,0.18)" : "rgba(34,197,94,0.2)", color: bad ? C.red : C.khGreen, fontSize: 20, fontWeight: 800 }}>{bad ? "✕" : "✓"}</div>
            <div style={{ fontFamily: F.sans, fontSize: 30, color: bad ? "rgba(255,255,255,0.6)" : C.white, textDecoration: bad ? "line-through" : "none", textDecorationColor: "rgba(229,72,77,0.6)" }}>{it}</div>
          </div>
        );
      })}
    </div>
  );
};

export const Close: React.FC<{ scene: Scene }> = ({ scene }) => {
  const f = useCurrentFrame();
  const L = scene.lead;
  const s = (sec: number) => L + Math.round(sec * 30);
  const cardFrom = s(11.9);
  const cmpOut = interpolate(f, [cardFrom - 10, cardFrom], [1, 0], clamp);
  const logo = useSpring(cardFrom, { damping: 14, stiffness: 100 });
  const montage = [
    { src: "img/keeperhub-guarded-run-steps.jpg", x: 120, y: 120, r: -4, t: 5.4 },
    { src: "img/console-executions.jpg", x: 1000, y: 160, r: 3, t: 6.2 },
    { src: "img/explorer-payment-tx.jpg", x: 520, y: 560, r: -2, t: 7.0 },
  ];
  return (
    <Bg tone="navy">
      <Audio src={staticFile("sfx/success.wav")} volume={0.45} startFrom={0} />
      {/* comparison */}
      <AbsoluteFill style={{ opacity: cmpOut }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 150, textAlign: "center" }}><Eyebrow light>Why it matters</Eyebrow></div>
        <Col x={160} from={L} title="Without KeeperCard" bad items={["private keys inside the agent", "a human approving every payment", "relayers, nonces and retries you own", "a ledger only you can vouch for"]} />
        <Col x={1040} from={s(5.2)} title="With KeeperCard + KeeperHub" items={["a card the chain enforces", "the agent pays on its own, within limits", "execution, gas and retries owned by KeeperHub", "three records: ledger · KeeperHub · on-chain receipt"]} />
      </AbsoluteFill>

      {/* montage behind the title card */}
      <AbsoluteFill style={{ opacity: 1 - cmpOut }}>
        {montage.map((m, i) => {
          const t = interpolate(f, [cardFrom + i * 8, cardFrom + 14 + i * 8], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
          const drift = (f - cardFrom) * 0.15;
          return <Img key={m.src} src={staticFile(m.src)} style={{ position: "absolute", left: m.x, top: m.y - drift, width: 780, borderRadius: 14, opacity: 0.22 * t, transform: `rotate(${m.r}deg) scale(${0.96 + 0.04 * t})`, filter: "saturate(0.8)", boxShadow: "0 30px 80px rgba(0,0,0,0.5)" }} />;
        })}
        <AbsoluteFill style={{ background: "radial-gradient(700px 400px at 50% 50%, rgba(11,18,32,0.92), rgba(11,18,32,0.55))" }} />
        <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 28, transform: `scale(${logo})` }}>
            <KCMark size={140} />
            <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 128, letterSpacing: -5, color: C.white }}>KeeperCard</div>
          </div>
          <Rise from={cardFrom + 16} style={{ marginTop: 26, display: "flex", alignItems: "center", gap: 18, fontFamily: F.sans, fontSize: 34, color: "rgba(255,255,255,0.8)" }}>
            built on <KHMark size={46} light />
          </Rise>
          <Rise from={cardFrom + 40} style={{ marginTop: 40, fontFamily: F.mono, fontSize: 22, color: C.khGreen, letterSpacing: 1 }}>github.com/LSUDOKO/KeeperCard · Base Sepolia · every payment verifiable on-chain</Rise>
        </AbsoluteFill>
      </AbsoluteFill>
    </Bg>
  );
};
