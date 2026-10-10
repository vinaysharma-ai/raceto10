import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";

import { env } from "@/lib/env";
import { HEADLINE } from "@/lib/headline";

import "./globals.css";

// Sans carries headings, body, and UI. Mono is reserved for numbers, stats,
// timestamps, and race data — never for prose.
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  // Resolves relative URLs in metadata to absolute ones. Reading it from the
  // validated env is also what makes the env validation run on every build and
  // every boot, rather than only when some later route happens to import it.
  metadataBase: new URL(env.NEXT_PUBLIC_APP_URL),
  // The headline, in all four places it can be read: the tab, the search
  // result, and the link card each site builds for the other. Every other route
  // sets its own title, so this one describes `/` and nothing else.
  title: HEADLINE,
  description: HEADLINE,
  openGraph: {
    type: "website",
    siteName: "raceto10",
    title: HEADLINE,
    description: HEADLINE,
  },
  twitter: {
    // The large card, because there is now an image to fill it —
    // `src/app/opengraph-image.tsx`, and a per-racer one under `/r/[handle]`.
    card: "summary_large_image",
    title: HEADLINE,
    description: HEADLINE,
  },
};

export const viewport: Viewport = {
  themeColor: "#0A0A0A",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${spaceGrotesk.variable} ${jetbrainsMono.variable} h-full`}
    >
      <body className="min-h-full flex flex-col bg-bg text-text font-sans">
        {children}
        {/* Page views, once for the whole app. It is here rather than in a
            page because the component has to be mounted on every route to
            catch client-side navigations, and mounting it twice would
            double-count. What it collects is described in `/privacy`. */}
        <Analytics />
      </body>
    </html>
  );
}
