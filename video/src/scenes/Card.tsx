import React from "react";
import type { Scene } from "../timeline";
import { Bg, Chip } from "../lib/ui";
import { Cuts, sec } from "../lib/Cuts";
import { Callout } from "../lib/Camera";
import { Rise } from "../lib/motion";

// voice anchors (s): 0 "A card is issued…" · 3.4 "This one is real… five-dollar…" · 9.8 "Funds stay…"
// · 13.3 "Connect Agent gives you one URL" · 15.5 "Any agent that speaks MCP…" · 18.3 end
const URL = "keepercard-dashboard.adoranto737.workers.dev";
export const Card: React.FC<{ scene: Scene }> = ({ scene }) => {
  const L = scene.lead;
  return (
    <Bg>
      <Cuts
        from={0}
        cuts={[
          // landing hero
          { src: "footage/landing.mp4", at: 1.6, dur: 3.5 + L / 30, url: URL, keys: [{ f: 0, x: 954, y: 420, s: 1.0 }, { f: 100, x: 954, y: 380, s: 1.12 }] },
          // the card: terms tab, back to activity
          { src: "footage/card.mp4", at: 6.5, dur: 9.9, url: URL + "/app", clicks: [6.2],
            keys: [{ f: 0, x: 954, y: 420, s: 1.0 }, { f: 40, x: 954, y: 360, s: 1.35 }, { f: 170, x: 954, y: 360, s: 1.35 }, { f: 215, x: 954, y: 690, s: 1.3 }, { f: 297, x: 954, y: 700, s: 1.3 }] },
          // connect agent modal
          { src: "footage/card.mp4", at: 22.3, dur: 6.2, url: URL + "/app", clicks: [0.5],
            keys: [{ f: 0, x: 954, y: 520, s: 1.1 }, { f: 50, x: 954, y: 470, s: 1.45 }] },
        ]}
      />
      <Callout x={180} y={14} from={sec(3.6) + L} until={sec(9.6) + L} text="$5.00 lifetime · expires in 30 days" sub="ERC-7710 delegation · caveats enforced on-chain" />
      <Callout x={180} y={14} from={sec(10.0) + L} until={sec(13.0) + L} text="Funds stay in your wallet" sub="nothing moves until a payment lands" />
      <Callout x={180} y={14} from={sec(13.5) + L} until={sec(18.8) + L} text="One URL, any MCP client" sub="Claude Code · Cursor · VS Code · OpenClaw" />
      <Rise from={sec(15.6) + L} style={{ position: "absolute", left: 1320, top: 30, display: "flex", gap: 10 }}>
        <Chip tone="ink" size={18}>secret blurred</Chip>
      </Rise>
    </Bg>
  );
};
