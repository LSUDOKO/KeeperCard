import React from "react";
import type { Scene } from "../timeline";
import { Bg } from "../lib/ui";
import { Cuts, sec } from "../lib/Cuts";
import { Callout } from "../lib/Camera";

// footage: console.mp4 — 4–6.5 treasury in view · 9–12 executions timeline · 14+ dry runs + receipts
//          explorer.mp4 — 1.5 hover on hash · 3–5 scroll · 5–9.5 hover token transfers
// voice: 0 "Back in KeeperCard, the execution console links…" · 5.9 "treasury live" · 8.2 "On an
// independent explorer…" · 13.3 "two USDC transfers…" · 18.1 end
const KC = "keepercard-dashboard.adoranto737.workers.dev/keeperhub";
export const Proof: React.FC<{ scene: Scene }> = ({ scene }) => {
  const L = scene.lead;
  return (
    <Bg>
      <Cuts
        from={0}
        cuts={[
          { src: "footage/console.mp4", at: 16.6, dur: 5.8 + L / 30, url: KC, keys: [{ f: 0, x: 954, y: 440, s: 1.0 }, { f: 70, x: 640, y: 230, s: 1.4 }] },
          { src: "footage/console.mp4", at: 2.0, dur: 2.4, url: KC, keys: [{ f: 0, x: 954, y: 560, s: 1.25 }, { f: 70, x: 954, y: 600, s: 1.3 }] },
          { src: "footage/explorer.mp4", at: 1.0, dur: 9.9, url: "base-sepolia.blockscout.com/tx/0x36c482c5…", keys: [{ f: 0, x: 954, y: 440, s: 1.0 }, { f: 110, x: 720, y: 320, s: 1.4 }, { f: 240, x: 700, y: 500, s: 1.7 }] },
        ]}
      />
      <Callout x={180} y={14} from={L + sec(0.4)} until={L + sec(5.6)} text="payment ⇄ on-chain receipt" sub="linked in the execution console" />
      <Callout x={180} y={14} from={L + sec(6.0)} until={L + sec(8.0)} text="treasury · read through KeeperHub" sub="gas · USDC · Chainlink USDC/USD" />
      <Callout x={180} y={14} from={L + sec(8.6)} until={L + sec(13.0)} text="independent explorer" sub="Success · via Turnkey gas station" />
      <Callout x={180} y={14} from={L + sec(13.4)} until={L + sec(18.8)} text="2 USDC transfers · 1 atomic tx" sub="merchant 0.03 · KeeperHub fee 0.0103" />
    </Bg>
  );
};
