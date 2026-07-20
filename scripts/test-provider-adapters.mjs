import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const outputDirectory = await mkdtemp(join(tmpdir(), "aido-provider-contract-"));

try {
  await execFileAsync(process.execPath, [
    resolve("node_modules/typescript/bin/tsc"),
    "scripts/provider-adapters.contract.ts",
    "lib/providers/types.ts",
    "lib/providers/adapters/shared.ts",
    "lib/providers/adapters/openai-responses.ts",
    "lib/providers/adapters/openai-compatible-chat.ts",
    "--outDir", outputDirectory,
    "--module", "commonjs",
    "--moduleResolution", "node",
    "--target", "ES2022",
    "--lib", "ES2022,DOM",
    "--types", "node",
    "--esModuleInterop",
    "--skipLibCheck",
  ], { cwd: process.cwd() });

  const { stdout, stderr } = await execFileAsync(process.execPath, [
    join(outputDirectory, "scripts/provider-adapters.contract.js"),
  ]);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
} finally {
  await rm(outputDirectory, { recursive: true, force: true });
}
