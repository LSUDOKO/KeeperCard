import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import type { Voice, Word } from "../timeline";
import { C, F } from "./theme";

const KEYWORDS = new Set([
  "KeeperCard", "KeeperCard.", "KeeperHub", "KeeperHub.", "KeeperHub's", "card", "card.", "card,", "dry", "run", "run.", "run:", "receipt", "receipt.", "receipt,",
  "on-chain", "on-chain.", "sponsored", "MCP", "MCP.", "plan,", "plan", "workflow", "workflow,", "workflow.", "atomic", "revocable", "delegation",
  "freeze", "revoke,", "confirmed", "hash.", "Turnkey,", "Chainlink", "ERC-7710",
]);

/** Group words into short caption chunks: break on punctuation or at 7 words. */
export function chunk(words: Word[]): { start: number; end: number; words: Word[] }[] {
  const out: { start: number; end: number; words: Word[] }[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ start: cur[0].t, end: cur[cur.length - 1].t + cur[cur.length - 1].d, words: cur });
    cur = [];
  };
  const endSoon = (i: number) => words.slice(i + 1, i + 4).some((x) => /[.!?:—]$/.test(x.w));
  words.forEach((w, i) => {
    cur.push(w);
    if (/[.!?:—]$/.test(w.w) || (cur.length >= 7 && /[,;]$/.test(w.w)) || (cur.length >= 9 && !endSoon(i)) || cur.length >= 12) flush();
  });
  flush();
  return out;
}

export const Captions: React.FC<{ voice: Voice; lead: number; dark?: boolean }> = ({ voice, lead, dark }) => {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = (f - lead) / fps;
  const chunks = React.useMemo(() => chunk(voice.words), [voice]);
  const cur = chunks.find((c) => t >= c.start - 0.05 && t < c.end + 0.35);
  if (!cur) return null;
  const age = t - cur.start;
  const o = Math.min(1, Math.max(0, age / 0.12 + 0.35));
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 58, display: "flex", justifyContent: "center", pointerEvents: "none" }}>
      <div
        style={{
          maxWidth: 1240, padding: "14px 26px", borderRadius: 16, opacity: o,
          background: dark ? "rgba(8,14,26,0.78)" : "rgba(26,51,0,0.86)", backdropFilter: "blur(10px)",
          color: C.white, fontFamily: F.sans, fontWeight: 500, fontSize: 34, lineHeight: 1.3, textAlign: "center", letterSpacing: -0.2,
          boxShadow: "0 12px 40px rgba(0,0,0,0.25)",
        }}
      >
        {cur.words.map((w, i) => {
          const spoken = t >= w.t - 0.02;
          const key = KEYWORDS.has(w.w.replace(/[.,:;—]+$/g, ""));
          return (
            <span key={i} style={{ opacity: spoken ? 1 : 0.42, color: key && spoken ? C.yellow : C.white, transition: "none", marginRight: "0.26em", fontWeight: key ? 600 : 500 }}>
              {w.w}
            </span>
          );
        })}
      </div>
    </div>
  );
};
