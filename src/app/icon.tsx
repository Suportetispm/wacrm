import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";

// Replaces the default Next.js favicon with the brand mark — SuperMassa
// red rounded square + the diamond glyph — matching the sidebar logo in
// `src/components/brand/logo.tsx`. Next.js renders this at build time
// and auto-injects <link rel="icon"> into <head>.
//
// This route takes precedence over src/app/favicon.ico, which is the
// Next.js default and can stay on disk harmlessly (or be removed).
//
// Uses the nodejs runtime (not edge) so `fs` can read the real logo
// asset instead of approximating it with a drawn SVG glyph.

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

const iconBase64 = readFileSync(
  join(process.cwd(), "public", "brand", "supermassa-icon.png"),
).toString("base64");

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#ffffff",
          borderRadius: 6,
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`data:image/png;base64,${iconBase64}`}
          alt=""
          width={18}
          height={25}
          style={{ objectFit: "contain" }}
        />
      </div>
    ),
    { ...size },
  );
}
