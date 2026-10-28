import { fileURLToPath } from "node:url";

// The demo reads committed fixtures from the repository root, so Next traces and watches from there.
const root = fileURLToPath(new URL("../..", import.meta.url));

export default {
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  outputFileTracingRoot: root,
  // The voice package ships TypeScript source, so Next compiles it with the app.
  transpilePackages: ["@hey-pisgah/voice"],
  // The shared libs use NodeNext ".js" specifiers for ".ts" files, which webpack maps and Turbopack does not.
  webpack: (config) => {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"], ".mjs": [".mts", ".mjs"] };
    return config;
  }
};
