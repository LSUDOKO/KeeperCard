import React from "react";
import { Audio, Sequence, staticFile } from "remotion";
import { Camera, type Key } from "./Camera";

export type Cut = {
  src: string;
  /** seconds into the footage */
  at: number;
  /** length on screen, seconds */
  dur: number;
  rate?: number;
  keys?: Key[];
  mode?: "card" | "full";
  pageTop?: number;
  url?: string;
  /** play a UI click at these local seconds */
  clicks?: number[];
};

/** Lays out footage cuts back to back starting at `from` (frames). */
export const Cuts: React.FC<{ from: number; cuts: Cut[]; fps?: number }> = ({ from, cuts, fps = 30 }) => {
  let cursor = from;
  return (
    <>
      {cuts.map((c, i) => {
        const frames = Math.round(c.dur * fps);
        const start = cursor;
        cursor += frames;
        return (
          <Sequence key={i} from={start} durationInFrames={frames}>
            <Camera src={c.src} startFrom={Math.round(c.at * fps)} keys={c.keys} mode={c.mode} pageTop={c.pageTop} url={c.url} playbackRate={c.rate ?? 1} fadeIn={i === 0 ? 10 : 6} />
            {(c.clicks ?? []).map((t, j) => (
              <Sequence key={j} from={Math.round(t * fps)}><Audio src={staticFile("sfx/click.wav")} volume={0.5} /></Sequence>
            ))}
          </Sequence>
        );
      })}
    </>
  );
};

/** Convenience: local seconds → frames. */
export const sec = (s: number, fps = 30) => Math.round(s * fps);
