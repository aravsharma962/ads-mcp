import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import { buildSync } from "esbuild";
import path from "node:path";

describe("tracker bundle", () => {
  it("is under 4 KB gzipped", () => {
    const out = buildSync({ entryPoints: [path.resolve(__dirname, "entry.ts")], bundle: true, minify: true, format: "iife", target: "es2018", write: false });
    expect(gzipSync(out.outputFiles[0].contents).length).toBeLessThan(4096);
  });
});
