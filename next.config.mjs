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
  // "Ambiente de Impressão" (EPERM) and aborts the build's file tracing.
  outputFileTracingRoot: __dirname,
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS
    ? process.env.ALLOWED_DEV_ORIGINS.split(",")
    : [],
};

export default nextConfig;
