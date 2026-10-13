import { qrPath } from "@/lib/qr";

/**
 * A QR code drawn as React SVG elements from `value` (rules 1620-1622): nothing is fetched and no markup is injected.
 * The tile and the modules use the palette primitives on purpose: they stay dark on white in the dark theme too,
 * because authenticator apps scan dark modules on a light ground most reliably.
 */
export default function QrCode({ value, label, px = 200 }: { value: string; label: string; px?: number }) {
  const { size, d } = qrPath(value);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${size} ${size}`} width={px} height={px} shapeRendering="crispEdges" className="mx-auto block rounded-lg border border-border">
      <rect width={size} height={size} style={{ fill: "var(--primitive-color-paper)" }} />
      <path d={d} style={{ fill: "var(--primitive-color-ink)" }} />
    </svg>
  );
}
