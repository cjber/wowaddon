import { runCli, tuiOptions } from "./cli";

const argv = process.argv.slice(2);
const exitCode = await runCli(argv);
if (exitCode !== undefined) process.exit(exitCode);

const { runTui } = await import("./tui/run");
process.exit(await runTui(tuiOptions(argv)));
