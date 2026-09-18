import React from "react";
import { AbsoluteFill } from "remotion";
import { C, F } from "./theme";

/** KeeperCard monogram, identical paths to the dashboard's Logo.tsx. */
export const KCMark: React.FC<{ size?: number; style?: React.CSSProperties }> = ({ size = 64, style }) => (
  <div style={{ width: size, height: size, borderRadius: size * 0.22, background: C.yellow, display: "grid", placeItems: "center", color: C.ink, ...style }}>
    <svg width={size * 0.86} height={size * 0.86} viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12.2 10.6c.4 5.6.3 11.2-.3 16.6M19.6 16.4c-2.3 2.3-4.6 3.9-7.2 5.2 2.9 1.2 5.4 3 7.6 5.6" />
      <path d="M30.4 18.6c-1.7-2.5-6.4-2.3-7.5 1.8-1 3.9 2.6 7.3 6.3 6 .8-.3 1.5-.8 2-1.4" />
    </svg>
  </div>
);

/** KeeperHub wordmark treatment: green keeper glyph + name. */
export const KHMark: React.FC<{ size?: number; light?: boolean }> = ({ size = 40, light }) => (
  <div style={{ display: "inline-flex", alignItems: "center", gap: size * 0.3, fontFamily: F.sans, fontWeight: 700, fontSize: size * 0.72, color: light ? C.white : C.ink, letterSpacing: -0.5 }}>
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <path d="M8 6h6l4 8 4-8h6L20 22v12h-6V22z" fill={C.khGreen} />
      <path d="M26 6h6v6h-6zM8 28h6v6H8z" fill={C.khGreen} opacity={0.55} />
    </svg>
    KeeperHub
  </div>
);

export const Bg: React.FC<{ tone?: "cream" | "navy"; children?: React.ReactNode }> = ({ tone = "cream", children }) => (
  <AbsoluteFill style={{ background: tone === "cream" ? C.cream : C.navy, overflow: "hidden" }}>
    {tone === "cream" ? (
      <AbsoluteFill style={{ background: "radial-gradient(900px 600px at 15% 10%, rgba(255,233,92,0.35), transparent 60%), radial-gradient(800px 500px at 90% 90%, rgba(217,242,196,0.55), transparent 60%)" }} />
    ) : (
      <AbsoluteFill style={{ background: "radial-gradient(1000px 700px at 80% 0%, rgba(34,197,94,0.12), transparent 60%), radial-gradient(700px 500px at 0% 100%, rgba(59,130,246,0.10), transparent 60%)" }} />
    )}
    <AbsoluteFill style={{ backgroundImage: `radial-gradient(${tone === "cream" ? "rgba(26,51,0,0.10)" : "rgba(255,255,255,0.07)"} 1px, transparent 1px)`, backgroundSize: "28px 28px", opacity: 0.7 }} />
    {children}
  </AbsoluteFill>
);

export const Eyebrow: React.FC<{ children: React.ReactNode; light?: boolean; style?: React.CSSProperties }> = ({ children, light, style }) => (
  <div style={{ fontFamily: F.mono, fontSize: 20, letterSpacing: 2.5, textTransform: "uppercase", color: light ? C.khGreen : C.moss, ...style }}>{children}</div>
);

export const H: React.FC<{ children: React.ReactNode; size?: number; light?: boolean; style?: React.CSSProperties }> = ({ children, size = 84, light, style }) => (
  <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: size, lineHeight: 1.02, letterSpacing: -size * 0.03, color: light ? C.white : C.ink, ...style }}>{children}</div>
);

export const P: React.FC<{ children: React.ReactNode; size?: number; light?: boolean; style?: React.CSSProperties }> = ({ children, size = 32, light, style }) => (
  <div style={{ fontFamily: F.sans, fontSize: size, lineHeight: 1.35, color: light ? "rgba(255,255,255,0.78)" : C.moss, ...style }}>{children}</div>
);

export const Chip: React.FC<{ children: React.ReactNode; tone?: "yellow" | "mint" | "ink" | "green" | "ghost"; size?: number; style?: React.CSSProperties }> = ({ children, tone = "yellow", size = 22, style }) => {
  const bg = { yellow: C.yellow, mint: C.mint, ink: C.ink, green: C.khGreen, ghost: "rgba(255,255,255,0.08)" }[tone];
  const fg = tone === "ink" || tone === "ghost" ? C.white : C.ink;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: `${size * 0.35}px ${size * 0.7}px`, borderRadius: 999, background: bg, color: fg, fontFamily: F.sans, fontWeight: 600, fontSize: size, letterSpacing: -0.2, ...style }}>
      {children}
    </span>
  );
};

export const Node: React.FC<{ x: number; y: number; w?: number; h?: number; title: string; sub?: string; tone?: "kc" | "kh" | "chain" | "agent" | "plain"; scale?: number; glow?: boolean; children?: React.ReactNode }> = ({ x, y, w = 260, h = 120, title, sub, tone = "plain", scale = 1, glow, children }) => {
  const palette = {
    kc: { bg: C.yellow, fg: C.ink, br: C.yellowDeep },
    kh: { bg: C.navy2, fg: C.white, br: C.khGreen },
    chain: { bg: "#0e2a4a", fg: C.white, br: "#3b82f6" },
    agent: { bg: C.white, fg: C.ink, br: C.ink },
    plain: { bg: C.white, fg: C.ink, br: C.line },
  }[tone];
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, height: h, transform: `scale(${scale})`, transformOrigin: "center", borderRadius: 18, background: palette.bg, color: palette.fg, border: `3px solid ${palette.br}`, boxShadow: glow ? `0 0 0 8px rgba(34,197,94,0.18), 0 20px 50px rgba(0,0,0,0.25)` : "0 18px 44px rgba(20,36,8,0.16)", display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 22px", fontFamily: F.sans }}>
      <div style={{ fontWeight: 700, fontSize: 26, letterSpacing: -0.4 }}>{title}</div>
      {sub && <div style={{ fontFamily: F.mono, fontSize: 16, opacity: 0.75, marginTop: 4 }}>{sub}</div>}
      {children}
    </div>
  );
};
