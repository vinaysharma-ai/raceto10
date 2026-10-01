import type { NextConfig } from "next";

/**
 * Allowlist for the image optimiser.
 *
 * This is the control that stops `/_next/image` fetching a URL of someone
 * else's choosing — the optimiser runs server-side, so an unrestricted URL
 * parameter would be an SSRF. Verified: loopback and cloud-metadata addresses
 * are rejected with `400 "url" parameter is not allowed`.
 *
 * It is currently a *second* layer rather than the only one. Sponsor logos
 * render through a plain `<img>` and are restricted to this same host in
 * `describeSlot`, so nothing in the app depends on this config today. It stays
 * because it is the guard that protects any future `next/image` with a remote
 * source.
 *
 * The hostname is derived from the environment rather than hardcoded, so it
 * cannot drift from where the app is actually pointed. `images.domains` is
 * deprecated in Next 16 in favour of `remotePatterns`.
 */
function supabaseHostname(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    // A malformed URL is reported loudly by src/lib/env.ts at request time.
    // Failing the build here with a stack trace from the config loader would
    // only obscure that message.
    return null;
  }
}

const hostname = supabaseHostname();

const nextConfig: NextConfig = {
  images: {
    remotePatterns: hostname
      ? [
          {
            protocol: "https",
            hostname,
            // Scoped to the public storage path. A wider pattern would let any
            // URL on the project host through the image optimiser.
            pathname: "/storage/v1/object/public/**",
          },
        ]
      : [],
  },
};

export default nextConfig;
