import type { Metadata, Viewport } from "next";
import { Space_Grotesk, JetBrains_Mono } from "next/font/google";

import { env } from "@/lib/env";

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
  title: "raceto10",
  description: "raceto10: connect Stripe, race to your first 10 customers.",
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
      </body>
    </html>
  );
}
