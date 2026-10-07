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

/**
 * Security headers.
 *
 * ## What is here, and why each one
 *
 *   * `X-Content-Type-Options: nosniff` — stops a browser guessing a type and
 *     running an uploaded file as script. Cheap, and nothing depends on MIME
 *     sniffing.
 *   * `Referrer-Policy: strict-origin-when-cross-origin` — the default in modern
 *     browsers, stated rather than assumed. Cross-origin destinations get the
 *     origin and never the path, so a link out of a racer page cannot leak which
 *     racer was being read.
 *   * `X-Frame-Options: DENY` — this product is not meant to be embedded, and a
 *     framed `/join` is a clickjacking surface on a page that takes a Stripe
 *     key.
 *   * `Permissions-Policy` — turns off the device APIs nothing uses. The camera,
 *     microphone, geolocation and payment request are all things a compromised
 *     dependency could reach for, and none of them is used by any page here.
 *   * `Strict-Transport-Security` — two years, with `preload`. Only ever sent
 *     over HTTPS, which is why it is conditional below: sending it over a plain
 *     HTTP connection is ignored by browsers, and sending it from localhost
 *     would pin a developer's browser to HTTPS on `localhost` for two years.
 *
 * ## No CSP, deliberately
 *
 * A content policy strict enough to be worth having breaks Mapbox and Next's
 * hydration in ways that are easy to introduce and hard to notice, and a policy
 * loose enough not to break them is mostly decoration. The decisions table says
 * no CSP in V1, and this is that decision rather than an omission.
 *
 * ## Why `/(.*)` and not `/`
 *
 * A `source` of `/` matches only the root path in Next's header config. Every
 * route — including the API ones and the assets — needs these, so the matcher
 * is explicit about covering all of them.
 */
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: [
      "camera=()",
      "microphone=()",
      "geolocation=()",
      "payment=()",
      "usb=()",
      "magnetometer=()",
      "gyroscope=()",
      "accelerometer=()",
    ].join(", "),
  },
];

/**
 * Whether to send HSTS.
 *
 * Only in production. A development server is plain HTTP, where the header is
 * ignored anyway, and a deployed preview on a `.vercel.app` host does not need
 * a two-year pin either. Setting it where it does nothing is how a header
 * becomes cargo.
 */
function hstsHeader() {
  if (process.env.NODE_ENV !== "production") return [];
  return [
    {
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains; preload",
    },
  ];
}

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [...SECURITY_HEADERS, ...hstsHeader()],
      },
    ];
  },

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
