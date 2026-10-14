import type { NextConfig } from "next";

// No script or connect restrictions: map tiles, satellite images and the browser fallback
// load from many hosts. These rules stop framing (clickjacking), <base> hijacking and plugins.
const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // The pointing screen uses the camera, GPS and motion sensors; nothing else is needed.
  { key: "Permissions-Policy", value: "camera=(self), microphone=(), geolocation=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self), payment=(), usb=()" },
];

const nextConfig: NextConfig = {
  // `next dev` would otherwise write AGENTS.md and CLAUDE.md into the project root.
  agentRules: false,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
