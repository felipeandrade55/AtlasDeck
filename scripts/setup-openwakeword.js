#!/usr/bin/env node
/**
 * postinstall: prepares openwakeword-js for Next.js Turbopack.
 *
 * The published package's `dist/index.js` references `new URL("./ort-
 * wasm-simd-threaded.{,jsep.}wasm", import.meta.url)` — those WASM
 * files live in the nested `onnxruntime-web` dependency, not in
 * `dist/`. At runtime the browser resolves them via the runtime
 * `wasmPaths` setting we provide, but Turbopack tries to resolve
 * them statically and fails the build.
 *
 * Fix: at install time, copy the four runtime files into the
 * openwakeword-js dist folder so the build-time resolver finds them
 * where the bundled URL points. The runtime keeps loading from our
 * own `/openwakeword/` public path, so the duplicate is harmless.
 *
 * Idempotent: skips silently when files already exist or the source
 * dir is missing (no-op for environments without the dep).
 */
const fs = require("fs");
const path = require("path");

const PKG_DIST = path.join(
  process.cwd(),
  "node_modules/openwakeword-js/dist",
);
const ORT_DIST = path.join(
  process.cwd(),
  "node_modules/openwakeword-js/node_modules/onnxruntime-web/dist",
);
const PUBLIC_DIR = path.join(process.cwd(), "public/openwakeword");

// Files needed at BUILD time inside openwakeword-js/dist so Turbopack
// can resolve the `new URL("./...", import.meta.url)` references that
// the bundled package emits.
const BUILD_FILES = [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort.bundle.min.mjs",
];

// Files needed at RUNTIME under /openwakeword/ in the browser so the
// model loader can fetch the onnxruntime-web wasm + the .mjs loader.
// The .jsep variant supports WebGPU; we ship both flavours.
const RUNTIME_FILES = [
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
];

if (!fs.existsSync(ORT_DIST)) {
  // openwakeword-js not installed; nothing to do.
  process.exit(0);
}

function copyIfMissing(src, dst, force = false) {
  if (!fs.existsSync(src)) return false;
  if (!force && fs.existsSync(dst)) return false;
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    return true;
  } catch (err) {
    console.warn(`[setup-openwakeword] failed to copy ${path.basename(src)}:`, err.message);
    return false;
  }
}

let copied = 0;

if (fs.existsSync(PKG_DIST)) {
  for (const file of BUILD_FILES) {
    if (copyIfMissing(path.join(ORT_DIST, file), path.join(PKG_DIST, file))) {
      copied += 1;
    }
  }
}

for (const file of RUNTIME_FILES) {
  if (copyIfMissing(path.join(ORT_DIST, file), path.join(PUBLIC_DIR, file))) {
    copied += 1;
  }
}

if (copied > 0) {
  console.log(`[setup-openwakeword] linked ${copied} onnxruntime asset(s) into dist + public`);
}
