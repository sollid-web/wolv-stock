import { ImageResponse } from "next/og";

export const alt = "WOLV: tokenized stocks on BNB Chain, compared before you trade";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background: "linear-gradient(135deg, #07070f 0%, #101528 60%, #1a1405 100%)", color: "#f8fafc", fontFamily: "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 56, height: 56, borderRadius: 14, background: "#d9a80a", display: "flex", alignItems: "center", justifyContent: "center", color: "#07070f", fontSize: 34, fontWeight: 800 }}>W</div>
          <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: 4 }}>WOLV</div>
          <div style={{ marginLeft: 16, fontSize: 22, color: "#94a3b8" }}>BNB Chain</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.05 }}>Tokenized stocks.</div>
          <div style={{ fontSize: 76, fontWeight: 800, lineHeight: 1.05, color: "#d9a80a" }}>Clearer decisions.</div>
          <div style={{ fontSize: 30, color: "#cbd5e1", marginTop: 8 }}>Reference vs on-chain prices · owner-controlled execution · policy-bound autonomous agent</div>
        </div>
        <div style={{ fontSize: 24, color: "#64748b" }}>wolv.space</div>
      </div>
    ),
    size,
  );
}
