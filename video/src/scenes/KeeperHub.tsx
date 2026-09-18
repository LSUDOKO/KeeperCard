import React from "react";
import { Audio, Sequence, staticFile } from "remotion";
import type { Scene } from "../timeline";
import { Bg } from "../lib/ui";
import { Cuts, sec } from "../lib/Cuts";
import { Callout } from "../lib/Camera";

// footage: kh-run.mp4 — 2 canvas hover · ~5 Runs tab · ~8.5 Run #5 clicked · 9.6+ steps expanded
//          kh-analytics.mp4 — 10+ runs table visible · 12–17 hover over the workflow rows
// voice: 0 "This is KeeperHub's own view" · 2.9 "Every step…" · 6.0 "sponsored" · 9.1 "Then KeeperHub
// kept going on its own" · 11.7 "second workflow wrote a receipt" · 15.8 "third one" · 18.0 end
const URL = "app.keeperhub.com";
export const KeeperHubScene: React.FC<{ scene: Scene }> = ({ scene }) => {
  const L = scene.lead;
  return (
    <Bg tone="navy">
      <Cuts
        from={0}
        cuts={[
          { src: "footage/kh-run.mp4", at: 3.0, dur: 4.6 + L / 30, url: URL + "/workflows/card-payment-redemption", clicks: [4.0], keys: [{ f: 0, x: 954, y: 440, s: 1.0 }, { f: 60, x: 900, y: 440, s: 1.08 }] },
          { src: "footage/kh-run.mp4", at: 19.5, dur: 4.5, url: URL + "/workflows/card-payment-redemption", keys: [{ f: 0, x: 1300, y: 260, s: 1.3 }, { f: 100, x: 1320, y: 250, s: 1.55 }] },
          { src: "footage/kh-analytics.mp4", at: 13.0, dur: 9.9, url: URL + "/analytics", keys: [{ f: 0, x: 954, y: 440, s: 1.0 }, { f: 70, x: 560, y: 600, s: 1.4 }, { f: 150, x: 560, y: 600, s: 1.4 }, { f: 210, x: 560, y: 150, s: 1.5 }] },
        ]}
      />
      <Callout dark x={180} y={14} from={L + sec(3.0)} until={L + sec(8.8)} text="Run #5 · every step succeeded" sub="Redeem Delegations · gas sponsored" />
      <Callout dark x={180} y={14} from={L + sec(9.3)} until={L + sec(15.5)} text="payment-receipt-anchor" sub="a second workflow · the on-chain receipt" />
      <Callout dark x={180} y={14} from={L + sec(15.9)} until={L + sec(19.0)} text="receipt-event-watcher" sub="Event trigger · started by the chain" />
      <Sequence from={L + sec(6.0)}><Audio src={staticFile("sfx/tick.wav")} volume={0.4} /></Sequence>
    </Bg>
  );
};
