// The logo lockup: a highlighter-yellow square carrying a hand-drawn "kc"
// monogram in forest ink (rounded, deliberately imperfect strokes), followed by
// the wordmark in Inter 700. One component, three sizes, used by every nav.

import Link from "next/link";

export function Monogram({ size = 36 }: { size?: number }) {
  return (
    <span className="lgmark" style={{ width: size, height: size }} aria-hidden>
      <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        {/* k: a tall stem, arm and leg meeting just off it */}
        <path d="M12.2 10.6c.4 5.6.3 11.2-.3 16.6M19.6 16.4c-2.3 2.3-4.6 3.9-7.2 5.2 2.9 1.2 5.4 3 7.6 5.6" />
        {/* c: an open bowl that stops short of closing */}
        <path d="M30.4 18.6c-1.7-2.5-6.4-2.3-7.5 1.8-1 3.9 2.6 7.3 6.3 6 .8-.3 1.5-.8 2-1.4" />
      </svg>
    </span>
  );
}

export function Logo({ href = "/", size = "md" }: { href?: string; size?: "sm" | "md" | "lg" }) {
  const px = size === "lg" ? 44 : size === "sm" ? 30 : 36;
  return (
    <Link className={`logo logo-${size}`} href={href} aria-label="KeeperCard">
      <Monogram size={px} />
      <span className="lgword">KeeperCard</span>
    </Link>
  );
}
