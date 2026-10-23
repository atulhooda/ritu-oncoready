import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No dev badge: bottom-left covers the sidebar footer, bottom-right the RITU assistant.
  // Build and runtime errors still open the dev overlay.
  devIndicators: false,
};

export default nextConfig;
