// The SnapCast Studio mark as JSX, for next/og images (apple-icon,
// opengraph-image). Same geometry as public/assets/icons/logo.svg.
export function BrandMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="64" height="64" fill="#111110" />
      <rect x="2.5" y="2.5" width="59" height="59" fill="none" stroke="#f2efe6" strokeWidth="3" />
      <path d="M14 18v28l22-14Z" fill="#ff4f12" />
      <rect x="40" y="26" width="5" height="12" fill="#f2efe6" />
      <rect x="47" y="20" width="5" height="24" fill="#f2efe6" />
      <rect x="54" y="28" width="4" height="8" fill="#f2efe6" />
    </svg>
  );
}
