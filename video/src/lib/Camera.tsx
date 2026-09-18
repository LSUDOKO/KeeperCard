import React from "react";
import { AbsoluteFill, Easing, interpolate, OffthreadVideo, staticFile, useCurrentFrame } from "remotion";
import { C, F } from "./theme";
import { clamp } from "./motion";

// Recorded footage is the Chrome window region (SRC_W × SRC_H). PAGE_TOP is the height of
// Chrome's own UI (tab strip, toolbar, the "debugging" bar) that is cropped away.
export const SRC_W = 1908, SRC_H = 1022;
export const PAGE_TOP = 143;
export const PAGE_W = SRC_W, PAGE_H = SRC_H - PAGE_TOP;

export type Key = { f: number; x: number; y: number; s: number };

type Props = {
  src: string;
  /** frame in the footage to start from */
  startFrom?: number;
  /** zoom keyframes: focus point (page px) and scale, interpolated between keys */
  keys?: Key[];
  /** 'card' = floating browser card with margins; 'full' = fills the frame */
  mode?: "card" | "full";
  /** crop-top override (e.g. terminal footage has no browser chrome) */
  pageTop?: number;
  srcW?: number; srcH?: number;
  /** fade-in frames */
  fadeIn?: number;
  url?: string;
  playbackRate?: number;
  muted?: boolean;
};

export const Camera: React.FC<Props> = ({ src, startFrom = 0, keys = [{ f: 0, x: PAGE_W / 2, y: PAGE_H / 2, s: 1 }], mode = "card", pageTop = PAGE_TOP, srcW = SRC_W, srcH = SRC_H, fadeIn = 8, url, playbackRate = 1 }) => {
  const f = useCurrentFrame();
  const pageW = srcW, pageH = srcH - pageTop;
  const W = mode === "card" ? 1560 : 1920;
  const k = W / pageW;
  const H = Math.round(pageH * k);
  const top = mode === "card" ? (1080 - H) / 2 + 40 : (1080 - H) / 2;
  const left = (1920 - W) / 2;
  const dark = !!url && !url.includes(".");

  // interpolate the camera between keyframes
  const ks = [...keys].sort((a, b) => a.f - b.f);
  let x = ks[0].x, y = ks[0].y, s = ks[0].s;
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i], b = ks[i + 1];
    if (f >= a.f && f <= b.f) {
      const t = interpolate(f, [a.f, b.f], [0, 1], { ...clamp, easing: Easing.inOut(Easing.cubic) });
      x = a.x + (b.x - a.x) * t; y = a.y + (b.y - a.y) * t; s = a.s + (b.s - a.s) * t;
      break;
    }
    if (f > b.f) { x = b.x; y = b.y; s = b.s; }
  }
  let tx = W / 2 - x * k * s, ty = H / 2 - y * k * s;
  tx = Math.min(0, Math.max(W - W * s, tx));
  ty = Math.min(0, Math.max(H - H * s, ty));
  const o = interpolate(f, [0, fadeIn], [0, 1], clamp);

  return (
    <AbsoluteFill style={{ opacity: o }}>
      {mode === "card" && (
        <div style={{ position: "absolute", left, top: top - 44, width: W, height: 44, borderRadius: "16px 16px 0 0", background: dark ? "#1b2437" : "#e9e5d8", display: "flex", alignItems: "center", padding: "0 18px", gap: 8, boxShadow: "0 30px 80px rgba(20,36,8,0.22)" }}>
          {["#f26d5b", "#f5bf4f", "#5fc66a"].map((c) => <div key={c} style={{ width: 12, height: 12, borderRadius: 12, background: c }} />)}
          {url && (
            <div style={{ marginLeft: 14, flex: 1, height: 28, borderRadius: 8, background: dark ? "#0b1220" : "#f7f4ea", display: "flex", alignItems: "center", padding: "0 12px", fontFamily: F.mono, fontSize: 15, color: dark ? "#9fb0c0" : C.moss }}>
              {url.includes(".") && <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} style={{ marginRight: 8 }}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>}
              {url}
            </div>
          )}
        </div>
      )}
      <div style={{ position: "absolute", left, top, width: W, height: H, overflow: "hidden", borderRadius: mode === "card" ? "0 0 16px 16px" : 0, background: dark ? "#0b1220" : "#fff", boxShadow: mode === "card" ? "0 30px 80px rgba(20,36,8,0.22)" : "none" }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H, transform: `translate(${tx}px, ${ty}px) scale(${s})`, transformOrigin: "0 0" }}>
          <OffthreadVideo
            src={staticFile(src)}
            startFrom={startFrom}
            playbackRate={playbackRate}
            muted
            style={{ position: "absolute", left: 0, top: -pageTop * k, width: srcW * k, height: srcH * k, objectFit: "fill" }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** A spotlight ring over the footage (screen coordinates), drawn on top of a Camera. */
export const Ring: React.FC<{ x: number; y: number; w: number; h: number; from: number; until?: number; color?: string }> = ({ x, y, w, h, from, until = 1e9, color = C.yellow }) => {
  const f = useCurrentFrame();
  const t = interpolate(f, [from, from + 12], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const o = interpolate(f, [until, until + 8], [1, 0], clamp);
  const pulse = 1 + 0.02 * Math.sin((f - from) / 5);
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, height: h, borderRadius: 14, border: `4px solid ${color}`, boxShadow: `0 0 0 6px rgba(255,233,92,0.25), 0 0 40px rgba(255,233,92,0.5)`, opacity: t * o, transform: `scale(${(0.9 + 0.1 * t) * pulse})`, pointerEvents: "none" }} />
  );
};

/** A short label pinned near a point of interest. */
export const Callout: React.FC<{ x: number; y: number; from: number; until?: number; text: string; sub?: string; dark?: boolean }> = ({ x, y, from, until = 1e9, text, sub, dark }) => {
  const f = useCurrentFrame();
  const t = interpolate(f, [from, from + 12], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const o = interpolate(f, [until, until + 8], [1, 0], clamp);
  return (
    <div style={{ position: "absolute", left: x, top: y, opacity: t * o, transform: `translateY(${(1 - t) * 12}px)`, pointerEvents: "none" }}>
      <div style={{ display: "inline-flex", flexDirection: "column", gap: 2, padding: "12px 18px", borderRadius: 12, background: dark ? C.navy2 : C.ink, color: C.white, fontFamily: F.sans, boxShadow: "0 14px 40px rgba(0,0,0,0.28)", borderLeft: `6px solid ${C.yellow}` }}>
        <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: -0.3 }}>{text}</span>
        {sub && <span style={{ fontSize: 18, opacity: 0.8, fontFamily: F.mono }}>{sub}</span>}
      </div>
    </div>
  );
};
