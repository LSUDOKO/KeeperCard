import React from "react";
import { Audio, Sequence, staticFile } from "remotion";
import type { Scene } from "../timeline";
import { Bg } from "../lib/ui";
import { Cuts, sec } from "../lib/Cuts";
import { Callout } from "../lib/Camera";

// Real Claude Code session (footage/agent.mp4). Footage moments (s): 8.5 launch banner · 62 prompt
// typed · 72 "Running the KeeperHub dry run now" · 84 "Calling keepercard 2 times" · 92 "Payment
// confirmed" · 100 full result with tx · 208 "Now pay 20 USDC" · 216 "exceeds the cap" · 221 refusal table
// voice anchors: 0 "Here, Claude Code…" · 3.8 "Asked to pay…" · 6.0 "dry-runs first" · 8.1 "simulates…"
// · 13.9 "Nothing has touched the chain" · 15.5 "Then it pays" · 19.3 "seconds later" · 21.0 "confirmed"
// · 23.7 "Asked for twenty dollars" · 28.6 "nothing was attempted on-chain" · 30.2 end
const T = "claude — ~/KeeperCard";
export const Payment: React.FC<{ scene: Scene }> = ({ scene }) => {
  const L = scene.lead;
  const term = { pageTop: 0, url: T } as const;
  return (
    <Bg tone="navy">
      <Cuts
        from={0}
        cuts={[
          { ...term, src: "footage/agent.mp4", at: 8.6, dur: 3.8 + L / 30, keys: [{ f: 0, x: 954, y: 511, s: 1.0 }, { f: 90, x: 500, y: 300, s: 1.3 }] },
          { ...term, src: "footage/agent.mp4", at: 61.4, dur: 6.2, rate: 1.6, keys: [{ f: 0, x: 954, y: 800, s: 1.35 }, { f: 170, x: 954, y: 860, s: 1.35 }] },
          { ...term, src: "footage/agent.mp4", at: 100.4, dur: 5.5, keys: [{ f: 0, x: 520, y: 220, s: 1.45 }, { f: 150, x: 520, y: 300, s: 1.45 }] },
          { ...term, src: "footage/agent.mp4", at: 84.2, dur: 4.0, rate: 2.0, keys: [{ f: 0, x: 954, y: 860, s: 1.3 }] },
          { ...term, src: "footage/agent.mp4", at: 101.0, dur: 4.2, keys: [{ f: 0, x: 620, y: 520, s: 1.5 }, { f: 120, x: 620, y: 545, s: 1.6 }] },
          { ...term, src: "footage/agent.mp4", at: 214.4, dur: 7.6, rate: 1.5, keys: [{ f: 0, x: 954, y: 760, s: 1.2 }, { f: 150, x: 640, y: 560, s: 1.45 }] },
        ]}
      />
      <Callout dark x={180} y={14} from={L + sec(0.6)} until={L + sec(3.6)} text="Claude Code · card connected over MCP" sub="--mcp-config keepercard.mcp.json" />
      <Callout dark x={180} y={14} from={L + sec(6.2)} until={L + sec(13.6)} text="keeperhub_dry_run" sub="simulate → plan_id · gas · risk · digest" />
      <Callout dark x={180} y={14} from={L + sec(14.0)} until={L + sec(15.3)} text="nothing has touched the chain" />
      <Callout dark x={180} y={14} from={L + sec(15.7)} until={L + sec(23.4)} text="pay(plan_id)" sub="same bytes → KeeperHub workflow → confirmed" />
      <Callout dark x={180} y={14} from={L + sec(24.2)} until={L + sec(31.5)} text="refused: over_lifetime_limit" sub="enforced by the card · nothing attempted on-chain" />
      <Sequence from={L + sec(21.0)}><Audio src={staticFile("sfx/success.wav")} volume={0.5} /></Sequence>
      <Sequence from={L + sec(28.3)}><Audio src={staticFile("sfx/tick.wav")} volume={0.5} /></Sequence>
    </Bg>
  );
};
