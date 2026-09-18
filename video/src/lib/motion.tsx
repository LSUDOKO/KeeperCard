import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from "remotion";

export const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0→1 over [from, from+dur] frames with a smooth ease-out. */
export function useT(from: number, dur: number, easing = Easing.out(Easing.cubic)) {
  const f = useCurrentFrame();
  return interpolate(f, [from, from + dur], [0, 1], { ...clamp, easing });
}

/** Spring-driven 0→1 that starts at `from`. */
export function useSpring(from: number, opts: { damping?: number; stiffness?: number; mass?: number } = {}) {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: f - from, fps, config: { damping: opts.damping ?? 18, stiffness: opts.stiffness ?? 120, mass: opts.mass ?? 0.9 } });
}

/** Rise-and-fade entrance. `from` in frames relative to the current sequence. */
export const Rise: React.FC<{ from?: number; dur?: number; dy?: number; children: React.ReactNode; style?: React.CSSProperties; out?: number }> = ({
  from = 0, dur = 16, dy = 22, children, style, out,
}) => {
  const f = useCurrentFrame();
  const t = interpolate(f, [from, from + dur], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
  const o = out === undefined ? 1 : interpolate(f, [out, out + 10], [1, 0], clamp);
  return <div style={{ opacity: t * o, transform: `translateY(${(1 - t) * dy}px)`, ...style }}>{children}</div>;
};

/** Reveal text word by word. */
export const Words: React.FC<{ text: string; from?: number; step?: number; style?: React.CSSProperties; hl?: string[] }> = ({ text, from = 0, step = 3, style, hl = [] }) => {
  const f = useCurrentFrame();
  const words = text.split(" ");
  return (
    <span style={style}>
      {words.map((w, i) => {
        const t = interpolate(f, [from + i * step, from + i * step + 10], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) });
        const isHl = hl.some((h) => w.replace(/[.,]/g, "") === h);
        return (
          <span key={i} style={{ display: "inline-block", opacity: t, transform: `translateY(${(1 - t) * 14}px)`, marginRight: "0.28em", ...(isHl ? { background: "#ffe95c", padding: "0 0.14em", borderRadius: 6 } : {}) }}>
            {w}
          </span>
        );
      })}
    </span>
  );
};

/** A dashed→solid connector line that draws itself. */
export const DrawLine: React.FC<{ x1: number; y1: number; x2: number; y2: number; from: number; dur?: number; color?: string; width?: number }> = ({ x1, y1, x2, y2, from, dur = 14, color = "#1a3300", width = 3 }) => {
  const t = useT(from, dur);
  const len = Math.hypot(x2 - x1, y2 - y1);
  return (
    <svg style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }} width={1920} height={1080}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={width} strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - t)} />
    </svg>
  );
};

/** A packet travelling along a straight segment, from→from+dur. */
export const Packet: React.FC<{ x1: number; y1: number; x2: number; y2: number; from: number; dur?: number; color?: string; size?: number; label?: string }> = ({ x1, y1, x2, y2, from, dur = 20, color = "#ffe95c", size = 14, label }) => {
  const f = useCurrentFrame();
  const t = interpolate(f, [from, from + dur], [0, 1], { ...clamp, easing: Easing.inOut(Easing.quad) });
  const vis = f >= from && f <= from + dur ? 1 : 0;
  const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
  return (
    <div style={{ position: "absolute", left: x - size / 2, top: y - size / 2, opacity: vis, pointerEvents: "none" }}>
      <div style={{ width: size, height: size, borderRadius: size, background: color, boxShadow: `0 0 18px ${color}` }} />
      {label && <div style={{ position: "absolute", left: size + 8, top: -6, fontFamily: "'Roboto Mono', monospace", fontSize: 18, color, whiteSpace: "nowrap" }}>{label}</div>}
    </div>
  );
};

/** Animated check mark. */
export const Check: React.FC<{ from: number; size?: number; color?: string; style?: React.CSSProperties }> = ({ from, size = 28, color = "#22c55e", style }) => {
  const t = useSpring(from, { damping: 14, stiffness: 160 });
  const d = useT(from + 4, 10);
  return (
    <div style={{ width: size, height: size, borderRadius: size, background: color, display: "grid", placeItems: "center", transform: `scale(${t})`, ...style }}>
      <svg width={size * 0.6} height={size * 0.6} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 12.5 9.5 18 20 6" strokeDasharray={30} strokeDashoffset={30 * (1 - d)} />
      </svg>
    </div>
  );
};

/** Counts a number from a→b. */
export const Counter: React.FC<{ from: number; dur: number; a: number; b: number; decimals?: number; prefix?: string; style?: React.CSSProperties; easing?: (t: number) => number }> = ({ from, dur, a, b, decimals = 2, prefix = "", style, easing }) => {
  const f = useCurrentFrame();
  const v = interpolate(f, [from, from + dur], [a, b], { ...clamp, easing: easing ?? Easing.inOut(Easing.cubic) });
  return <span style={style}>{prefix}{v.toFixed(decimals)}</span>;
};
