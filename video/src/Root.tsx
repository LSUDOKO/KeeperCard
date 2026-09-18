import React from "react";
import { AbsoluteFill, Audio, Composition, Sequence, staticFile, interpolate, useCurrentFrame } from "remotion";
import { FPS, SCENES, TOTAL_FRAMES, type Scene } from "./timeline";
import { Captions } from "./lib/Captions";
import { clamp } from "./lib/motion";
import { Problem } from "./scenes/Problem";
import { Meet } from "./scenes/Meet";
import { Card } from "./scenes/Card";
import { Payment } from "./scenes/Payment";
import { KeeperHubScene } from "./scenes/KeeperHub";
import { Proof } from "./scenes/Proof";
import { Features } from "./scenes/Features";
import { Architecture } from "./scenes/Architecture";
import { Close } from "./scenes/Close";

const FONT_CSS = `
@font-face { font-family: 'Bricolage Grotesque'; src: url('${staticFile("fonts/bricolage.woff2")}') format('woff2'); font-weight: 200 800; }
@font-face { font-family: 'Inter'; src: url('${staticFile("fonts/inter.woff2")}') format('woff2'); font-weight: 100 900; }
@font-face { font-family: 'Roboto Mono'; src: url('${staticFile("fonts/robotomono.woff2")}') format('woff2'); font-weight: 100 700; }
* { box-sizing: border-box; }
`;

const SCENE_COMPONENTS: Record<Scene["name"], React.FC<{ scene: Scene }>> = {
  problem: Problem, meet: Meet, card: Card, payment: Payment, keeperhub: KeeperHubScene, proof: Proof, features: Features, architecture: Architecture, close: Close,
};
const DARK_CAPTIONS = new Set<Scene["name"]>(["keeperhub", "architecture", "close"]);

/** Fades a scene in and out at its edges so cuts never pop. */
const Fade: React.FC<{ frames: number; children: React.ReactNode }> = ({ frames, children }) => {
  const f = useCurrentFrame();
  const o = Math.min(interpolate(f, [0, 9], [0, 1], clamp), interpolate(f, [frames - 9, frames], [1, 0], clamp));
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
};

export const Demo: React.FC = () => (
  <AbsoluteFill style={{ background: "#0b1220" }}>
    <style>{FONT_CSS}</style>
    {SCENES.map((s) => {
      const Comp = SCENE_COMPONENTS[s.name];
      return (
        <Sequence key={s.name} from={s.from} durationInFrames={s.frames} name={s.name}>
          <Fade frames={s.frames}>
            <Comp scene={s} />
            <Captions voice={s.voice} lead={s.lead} dark={DARK_CAPTIONS.has(s.name)} />
          </Fade>
          <Sequence from={s.lead}><Audio src={staticFile(`voice/${s.name}.mp3`)} volume={1} /></Sequence>
          <Audio src={staticFile("sfx/whoosh.wav")} volume={0.35} />
        </Sequence>
      );
    })}
    <Audio src={staticFile("sfx/music.wav")} volume={(f) => interpolate(f, [0, 40, TOTAL_FRAMES - 90, TOTAL_FRAMES], [0, 0.16, 0.16, 0], clamp)} />
  </AbsoluteFill>
);

export const Root: React.FC = () => (
  <Composition id="Demo" component={Demo} durationInFrames={TOTAL_FRAMES} fps={FPS} width={1920} height={1080} />
);
