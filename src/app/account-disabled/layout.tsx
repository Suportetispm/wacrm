import type { Metadata } from "next";
import type { ReactNode } from "react";

// Same noindex posture as (auth)/layout.tsx and (dashboard)/layout.tsx
// — this page only exists behind an authenticated-but-disabled
// session and has nothing to offer a search visitor.
export const metadata: Metadata = {
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default function AccountDisabledLayout({ children }: { children: ReactNode }) {
  return children;
}
