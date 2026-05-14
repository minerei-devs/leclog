import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const outfile = join(tmpdir(), `leclog-m1-transcript-smoke-${process.pid}.mjs`);

try {
  await build({
    entryPoints: [new URL("./m1-transcript-smoke.ts", import.meta.url).pathname],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });

  await import(pathToFileURL(outfile));
} finally {
  await rm(outfile, { force: true });
}
