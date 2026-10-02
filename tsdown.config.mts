import { defineConfig } from "tsdown";

// Ships ESM (import) and CJS (require) side by side so `import Logspot from
// "@logspot/web"` resolves to a real default export under strict ESM interop
// (Vite 8, Node ESM) while existing `require` users keep the same shape.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  platform: "browser",
  target: "es2017",
  dts: true,
  // CJS keeps 5.3's dist/index.js + index.d.ts: TypeScript < 4.7 cannot read .d.cts.
  fixedExtension: false,
  sourcemap: false,
  // CJS keeps the 5.3 shape: exports.default plus named exports.
  outputOptions: { exports: "named" },
  publint: true,
  attw: { profile: "strict" },
});
