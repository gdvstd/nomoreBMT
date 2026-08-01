import type { NextConfig } from "next";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const webpack = require("webpack");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  webpack(config) {
    // OpenPencil's browser bundle contains Node-only font/CanvasKit fallbacks.
    // They are never executed in the client editor, but webpack still resolves
    // them while creating the dynamic chunk.
    config.resolve.fallback = {
      ...(config.resolve.fallback ?? {}),
      fs: false,
      path: false,
      url: false,
      "node:fs": false,
      "node:fs/promises": false,
      "node:path": false,
      "node:url": false,
    };
    const browserStub = `${process.cwd()}/lib/empty-node-module.ts`;
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^node:fs\/promises$/, browserStub));
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^node:path$/, browserStub));
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(/^node:url$/, browserStub));
    return config;
  },
};

export default nextConfig;
