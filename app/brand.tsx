// The SnapCast Studio mark as JSX, for next/og images (apple-icon,
// opengraph-image). Same geometry as public/assets/icons/logo.svg.
export function BrandMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="t" x1="0" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3a2d74" />
          <stop offset="1" stopColor="#15112b" />
        </linearGradient>
        <linearGradient id="p" x1="16" y1="18" x2="38" y2="46" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ff5fa2" />
          <stop offset="1" stopColor="#ff7a3d" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#t)" />
      <path d="M2 18A16 16 0 0 1 18 2h28a16 16 0 0 1 16 16v4C46 15 18 15 2 26Z" fill="#ffffff" fillOpacity="0.12" />
      <rect x="2.75" y="2.75" width="58.5" height="58.5" rx="15.25" stroke="#ffffff" strokeOpacity="0.16" strokeWidth="1.5" />
      <path d="M17 21.4c0-2.3 2.5-3.7 4.5-2.5l15.7 9.6c1.9 1.2 1.9 3.9 0 5L21.5 43.1c-2 1.2-4.5-.2-4.5-2.5Z" fill="url(#p)" />
      <rect x="41" y="26" width="4.5" height="12" rx="2.25" fill="#ffffff" />
      <rect x="47.5" y="21" width="4.5" height="22" rx="2.25" fill="#ffffff" fillOpacity="0.92" />
      <rect x="54" y="27.5" width="4.5" height="9" rx="2.25" fill="#ffffff" fillOpacity="0.75" />
    </svg>
  );
}
