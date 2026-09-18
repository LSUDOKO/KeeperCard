import React from "react";
import { AbsoluteFill, Audio, interpolate, Sequence, staticFile, useCurrentFrame } from "remotion";
import type { Scene } from "../timeline";
import { Bg, Chip } from "../lib/ui";
import { Cuts, sec } from "../lib/Cuts";
import { C, F } from "../lib/theme";
import { clamp } from "../lib/motion";

// voice: 0 "Every payment must be dry-run first" · 2.8 "High-value payments run a guarded workflow…"
// · 7.3 "condition the write cannot bypass" · 10.0 "A scheduled workflow watches the wallets every ten
// minutes" · 13.8 "Receipts are event-triggered" · 15.5 "And when you freeze a card…" · 21.4 end
const KC = "keepercard-dashboard.adoranto737.workers.dev";
const KH = "app.keeperhub.com";

const Tag: React.FC<{ from: number; until: number; label: string; sub: string; dark?: boolean }> = ({ from, until, label, sub, dark }) => {
  const f = useCurrentFrame();
  const t = interpolate(f, [from, from + 10], [0, 1], clamp) * interpolate(f, [until, until + 6], [1, 0], clamp);
  return (
    <div style={{ position: "absolute", left: 180, top: 12, flexDirection: "row", alignItems: "center", opacity: t, transform: `translateY(${(1 - t) * 10}px)`, display: "flex", gap: 16 }}>
      <Chip tone="yellow" size={26}>{label}</Chip>
      <span style={{ fontFamily: F.mono, fontSize: 18, color: dark ? "rgba(255,255,255,0.75)" : C.moss, paddingLeft: 6 }}>{sub}</span>
    </div>
  );
};

export const Features: React.FC<{ scene: Scene }> = ({ scene }) => {
  const L = scene.lead;
  const f = useCurrentFrame();
  // background flips to navy for the KeeperHub clips
  const navy = (f >= L + sec(2.8) && f < L + sec(13.8));
  return (
    <AbsoluteFill>
      <Bg tone={navy ? "navy" : "cream"} />
      <Cuts
        from={0}
        cuts={[
          { src: "footage/console.mp4", at: 19.0, dur: 2.8 + L / 30, url: KC + "/keeperhub", keys: [{ f: 0, x: 700, y: 520, s: 1.3 }, { f: 80, x: 700, y: 560, s: 1.35 }] },
          { src: "footage/guarded.mp4", at: 3.0, dur: 7.2, url: KH + "/workflows/guarded-card-payment", keys: [{ f: 0, x: 954, y: 440, s: 1.0 }, { f: 60, x: 760, y: 400, s: 1.35 }, { f: 200, x: 900, y: 400, s: 1.4 }] },
          { src: "footage/treasury.mp4", at: 8.6, dur: 3.8, url: KH + "/workflows/treasury-monitor", keys: [{ f: 0, x: 1300, y: 300, s: 1.35 }, { f: 100, x: 1300, y: 380, s: 1.45 }] },
          { src: "footage/kh-analytics.mp4", at: 24.0, dur: 1.7, url: KH + "/analytics", keys: [{ f: 0, x: 520, y: 150, s: 1.6 }] },
          { src: "footage/freeze.mp4", at: 3.4, dur: 6.5, url: KC + "/app", clicks: [1.6], keys: [{ f: 0, x: 954, y: 380, s: 1.2 }, { f: 60, x: 954, y: 330, s: 1.4 }, { f: 190, x: 954, y: 330, s: 1.4 }] },
        ]}
      />
      <Tag from={L + sec(0.2)} until={L + sec(2.6)} label="Dry-run gate" sub="a plan that was never simulated cannot execute" />
      <Tag dark from={L + sec(3.0)} until={L + sec(9.7)} label="Risk-guarded workflow" sub="Assess Risk → Condition → Redeem · the write is only reachable through “true”" />
      <Tag dark from={L + sec(10.2)} until={L + sec(13.5)} label="Scheduled monitor" sub="treasury-monitor · run #50 · every 10 minutes, KeeperHub's cron" />
      <Tag dark from={L + sec(13.9)} until={L + sec(15.3)} label="Event-triggered receipts" sub="PaymentAnchored → receipt-event-watcher" />
      <Tag from={L + sec(15.7)} until={L + sec(22.2)} label="Freeze · Revoke · Nuke" sub="server-side instantly · on-chain underneath" />
      <Sequence from={L + sec(16.8)}><Audio src={staticFile("sfx/tick.wav")} volume={0.4} /></Sequence>
    </AbsoluteFill>
  );
};
