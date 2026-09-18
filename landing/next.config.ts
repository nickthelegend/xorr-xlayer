import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives inside the Expo repo, which has its own lockfile. Left to infer, Turbopack roots itself at the
  // repo and watches the Expo app's node_modules as well.
  turbopack: {
    root: path.resolve(__dirname),
  },
  images: {
    // Required from Next.js 16: the optimizer produces only the qualities listed here.
    qualities: [75, 90],
  },
};

export default nextConfig;
