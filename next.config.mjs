import { fileURLToPath } from "url";
import { dirname } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: __dirname,
  },
  // Pin the file-tracing root to this project. Otherwise Next infers the
  // workspace root from lockfiles further up the tree and scans the user's
  // home directory, which on Windows trips over protected folders like
  // "Ambiente de Impressão" (EPERM) and aborts the webpack build.
  outputFileTracingRoot: __dirname,
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS
    ? process.env.ALLOWED_DEV_ORIGINS.split(",")
    : [],
  webpack: (config) => {
    // `openwakeword-js` (voice wake-word) ships a tsup bundle that inlines
    // onnxruntime-web and loads its runtime wasm/mjs chunks via
    // `new URL("ort.bundle.min.mjs", import.meta.url)`. webpack treats those
    // as build-time asset requests and fails to resolve them
    // ("Module not found: Can't resolve 'ort.bundle.min.mjs'"), which breaks
    // `next build`. Disabling the URL asset parser for this one package leaves
    // the native `new URL()` in place so the chunks resolve in the browser at
    // runtime instead of being bundled.
    config.module.rules.push({
      test: /[\\/]node_modules[\\/]openwakeword-js[\\/]/,
      parser: { url: false },
    });
    return config;
  },
};

export default nextConfig;
