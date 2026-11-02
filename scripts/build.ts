import { mkdirSync } from "node:fs";

// One architecture per call when given (each CI runner builds its own natively), otherwise both.
const arches = process.argv[2] ? [process.argv[2]] : ["x64", "arm64"];
mkdirSync("dist", { recursive: true });
for (const arch of arches) {
  const argv = [
    "bun",
    "build",
    "--compile",
    `--target=bun-linux-${arch}`,
    "src/index.tsx",
    "--outfile",
    `dist/wowaddon-linux-${arch}`,
  ];
  const result = Bun.spawnSync(argv, { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
