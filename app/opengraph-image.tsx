import { ImageResponse } from "next/og";
import { BrandMark } from "./brand";

export const alt = "SnapCast Studio: record, edit, caption and share in your browser";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between",
          padding: "72px 80px", color: "#fff",
          backgroundColor: "#0b1019",
          backgroundImage: "radial-gradient(circle at 85% 0%, #243a6e 0%, rgba(11,16,25,0) 55%), radial-gradient(circle at 0% 100%, #123a4a 0%, rgba(11,16,25,0) 50%)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <BrandMark size={96} />
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontSize: 52, fontWeight: 800, letterSpacing: -1.5 }}>SnapCast</div>
            <div style={{ fontSize: 26, color: "#7fdcff", letterSpacing: 6, textTransform: "uppercase" }}>Studio</div>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 64, fontWeight: 800, lineHeight: 1.08, letterSpacing: -2, maxWidth: 980 }}>
            Record once. Edit like a doc. Ship clean video.
          </div>
          <div style={{ fontSize: 28, color: "#b8c4dc" }}>
            Transcript editing · captions · audio studio · multitrack · all in your browser
          </div>
        </div>
      </div>
    ),
    size
  );
}
