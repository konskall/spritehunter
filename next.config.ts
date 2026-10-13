import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // `next dev` would otherwise write AGENTS.md and CLAUDE.md into the project root.
  agentRules: false,
};

export default nextConfig;
