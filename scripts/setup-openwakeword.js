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

// ---------------------------------------------------------------------------
// Patch the bundled `import(e)` so webpack does not replace it with a stub.
//
// openwakeword-js ships its own copy of onnxruntime-web inlined into
// `dist/index.js`. Inside that bundle there is:
//
//   oo = async e => (await import(e)).default
//
// where `e` is the runtime URL of `ort-wasm-simd-threaded(.jsep).mjs`.
// webpack treats this as a "too dynamic" import — it cannot statically
// determine which modules might be loaded, so the production build
// replaces the `import(e)` expression with a stub that throws:
//
//   Error: Cannot find module as expression is too dynamic
//   throw t.code = "MODULE_NOT_FOUND"
//
// All four ORT backends ([wasm], [cpu], [webnn], [webgpu]) depend on
// that loader, so the model surface fails to initialize with
// "no available backend found" and wake-word detection never starts.
//
// Fix: rewrite the `import(e)` calls to add the `/* webpackIgnore: true */`
// magic comment. webpack then leaves the dynamic import alone, the
// browser executes a native ESM `import(<url>)` at runtime, and ORT
// loads its glue module from `/openwakeword/` like we already serve it.
//
// Idempotent: matches the un-patched form only.
// ---------------------------------------------------------------------------
const DIST_INDEX = path.join(PKG_DIST, "index.js");
if (fs.existsSync(DIST_INDEX)) {
  try {
    const original = fs.readFileSync(DIST_INDEX, "utf8");
    // Match `await import(<single-identifier>)` exactly — avoids touching
    // any patched form that already carries a magic comment.
    const dynamicImport = /await import\(([A-Za-z_$][\w$]*)\)/g;
    let touched = 0;
    const patched = original.replace(dynamicImport, (full, ident) => {
      touched += 1;
      return `await import(/* webpackIgnore: true */ ${ident})`;
    });
    if (touched > 0 && patched !== original) {
      fs.writeFileSync(DIST_INDEX, patched);
      console.log(
        `[setup-openwakeword] patched ${touched} dynamic import(s) in openwakeword-js/dist/index.js (webpackIgnore)`,
      );
    }
  } catch (err) {
    console.warn("[setup-openwakeword] failed to patch dist/index.js:", err.message);
  }
}
