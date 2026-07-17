import { useId } from "react";

/**
 * Animated glass trade-globe: a frosted glass orb (backdrop-blur over the
 * aurora behind it) carrying a wireframe sphere whose branded azure lines
 * read clearly in BOTH themes (var(--globe-line)). The globe turns — the
 * meridian group spins 360° around the centre so the longitude lines sweep
 * through every angle (the reference hero's technique) while the latitude
 * bands stay put — plus pulsing supply-route arcs, a rotating specular sheen
 * and a spinning orbit ring. Pure inline SVG/CSS — no canvas, no runtime JS,
 * no external assets — and every animation is neutralised by the global
 * prefers-reduced-motion kill switch. Square 360×360 space so a rounded-full
 * glass layer aligns with the sphere. Adapted from The Drop's hero.
 */
const R = 150;
const CX = 180;
const CY = 180;

// A meridian at rotation θ projects to an ellipse of horizontal radius R·|cosθ|.
const MERIDIANS = [0, 30, 60, 90, 120, 150].map(
  (deg) => Math.abs(Math.cos((deg * Math.PI) / 180)) * R,
);
// Parallels: latitude bands as foreshortened ellipses.
const PARALLELS = [-60, -30, 0, 30, 60].map((lat) => {
  const rad = (lat * Math.PI) / 180;
  return { cy: CY - Math.sin(rad) * R, rx: Math.cos(rad) * R, ry: Math.cos(rad) * R * 0.3 };
});
// Great-circle route legs across the visible face, staggered so arcs chain.
const ARCS = [
  { d: "M 95 150 Q 150 175 200 120", delay: "0s" },
  { d: "M 200 120 Q 212 155 250 175", delay: "1.1s" },
  { d: "M 250 175 Q 272 205 300 210", delay: "2.2s" },
  { d: "M 90 225 Q 150 200 200 120", delay: "3s" },
];
const NODES = [
  { cx: 95, cy: 150 },
  { cx: 200, cy: 120 },
  { cx: 250, cy: 175 },
  { cx: 300, cy: 210 },
  { cx: 90, cy: 225 },
];
const STARS = [
  [28, 55],
  [332, 80],
  [55, 300],
  [322, 312],
  [24, 175],
  [336, 225],
  [120, 28],
  [300, 36],
];

export function HeroGlobe({ className }: { className?: string }) {
  const uid = useId().replace(/:/g, "");
  const arcGrad = `arc-${uid}`;
  const meridGrad = `merid-${uid}`;
  const glow = `glow-${uid}`;
  return (
    <div className={className} aria-hidden>
      {/* Drifting aurora blobs — the glass orb frosts these */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="animate-aurora-slow absolute -top-6 left-[10%] size-72 rounded-full bg-primary/25 blur-[110px] dark:bg-primary/45" />
        <div className="animate-aurora-fast absolute bottom-[-8%] right-[8%] size-72 rounded-full bg-info/20 blur-[120px] dark:bg-info/35" />
      </div>

      <div className="globe-scene absolute inset-0 grid place-items-center">
        <div className="relative aspect-square w-[88%]">
          {/* Glass orb — frosted, rim-lit */}
          <div className="absolute inset-0 rounded-full border border-white/25 bg-white/5 shadow-[0_40px_90px_-40px_oklch(0.4_0.1_250/0.55)] backdrop-blur-md dark:border-white/10 dark:bg-white/[0.035]" />
          {/* Rotating specular sheen — the lit side turning */}
          <div className="absolute inset-0 overflow-hidden rounded-full">
            <div className="animate-globe-sheen absolute inset-[-25%] bg-[conic-gradient(from_0deg,transparent_0deg,var(--globe-halo)_55deg,transparent_130deg,transparent_360deg)]" />
          </div>
          {/* Fixed top-left specular highlight */}
          <div className="absolute inset-0 rounded-full bg-[radial-gradient(55%_45%_at_34%_28%,oklch(1_0_0/0.45),transparent_58%)] dark:bg-[radial-gradient(55%_45%_at_34%_28%,oklch(1_0_0/0.16),transparent_58%)]" />

          {/* Wireframe sphere + routes */}
          <svg viewBox="0 0 360 360" className="relative size-full" role="presentation">
            <defs>
              <linearGradient id={arcGrad} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="var(--color-primary)" stopOpacity="0" />
                <stop offset="0.5" stopColor="var(--color-primary)" />
                <stop offset="1" stopColor="var(--color-info)" stopOpacity="0" />
              </linearGradient>
              <linearGradient id={meridGrad} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--globe-line)" />
                <stop offset="1" stopColor="var(--globe-line-soft)" />
              </linearGradient>
              <filter id={glow} x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="2.2" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Twinkling starfield */}
            {STARS.map(([x, y], i) => (
              <circle
                // biome-ignore lint/suspicious/noArrayIndexKey: static decorative field
                key={i}
                cx={x}
                cy={y}
                r={i % 3 === 0 ? 1.6 : 1}
                fill="var(--color-muted-foreground)"
                className="animate-twinkle"
                style={{ animationDelay: `${(i % 4) * 0.7}s` }}
              />
            ))}

            {/* Spinning orbit ring */}
            <g
              className="animate-orbit-slow"
              style={{ transformBox: "fill-box", transformOrigin: "center" }}
            >
              <ellipse
                cx={CX}
                cy={CY}
                rx="172"
                ry="56"
                fill="none"
                stroke="var(--globe-line-soft)"
                strokeWidth="1"
                strokeDasharray="2 9"
              />
            </g>

            {/* Static silhouette + latitude bands (a globe rotating on its
                vertical axis: the parallels stay, the meridians sweep). */}
            <circle
              cx={CX}
              cy={CY}
              r={R}
              fill="none"
              stroke="var(--globe-line)"
              strokeWidth="1.3"
            />
            {PARALLELS.map((p, i) => (
              <ellipse
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed geometry list
                key={`p${i}`}
                cx={CX}
                cy={p.cy}
                rx={p.rx}
                ry={p.ry}
                fill="none"
                stroke="var(--globe-line-soft)"
                strokeWidth="0.8"
              />
            ))}

            {/* Meridians spin around the globe centre → the sphere turns */}
            <g
              className="animate-globe-spin"
              style={{ transformBox: "fill-box", transformOrigin: "center" }}
            >
              {MERIDIANS.map((rx, i) => (
                <ellipse
                  // biome-ignore lint/suspicious/noArrayIndexKey: fixed geometry list
                  key={`m${i}`}
                  cx={CX}
                  cy={CY}
                  rx={rx}
                  ry={R}
                  fill="none"
                  stroke={`url(#${meridGrad})`}
                  strokeWidth="0.9"
                />
              ))}
            </g>

            {/* Supply-route arcs (base + animated dash sweep) */}
            <g filter={`url(#${glow})`}>
              {ARCS.map((arc, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed route list
                <g key={`a${i}`}>
                  <path d={arc.d} fill="none" stroke="var(--globe-line-soft)" strokeWidth="1.2" />
                  <path
                    d={arc.d}
                    fill="none"
                    stroke={`url(#${arcGrad})`}
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeDasharray="60 340"
                    className="animate-arc-dash"
                    style={{ animationDelay: arc.delay }}
                  />
                </g>
              ))}
            </g>

            {/* Route nodes with a pulsing halo on the primary hubs */}
            {NODES.map((n, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed node list
              <g key={`n${i}`}>
                {i % 2 === 0 && (
                  <circle
                    cx={n.cx}
                    cy={n.cy}
                    r="5"
                    fill="var(--color-primary)"
                    className="animate-node-ping"
                    style={{ animationDelay: `${i * 0.5}s` }}
                  />
                )}
                <circle cx={n.cx} cy={n.cy} r="3.2" fill="var(--color-primary)" />
                <circle cx={n.cx} cy={n.cy} r="1.4" fill="var(--color-background)" />
              </g>
            ))}
          </svg>

          {/* Glass rim highlight over everything */}
          <div className="pointer-events-none absolute inset-0 rounded-full ring-1 ring-inset ring-white/20 dark:ring-white/10" />
        </div>
      </div>
    </div>
  );
}
