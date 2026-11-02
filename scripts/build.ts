import { existsSync, mkdirSync } from "node:fs";

// Builds the host architecture, the one given (x64 or arm64), or both with "all". CI builds each
// natively on its own runner. A cross build needs the other architecture's OpenTUI native package,
// which a plain install leaves out: bun install --os linux --cpu "*".
const host = process.arch === "arm64" ? "arm64" : "x64";
const wanted = process.argv[2] ?? host;
const arches = wanted === "all" ? ["x64", "arm64"] : [wanted];
mkdirSync("dist", { recursive: true });
for (const arch of arches) {
  if (!existsSync(`node_modules/@opentui/core-linux-${arch}`)) {
    console.error(
      `@opentui/core-linux-${arch} is not installed; for a cross build run: bun install --os linux --cpu "*"`,
    );
    process.exit(1);
  }
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
