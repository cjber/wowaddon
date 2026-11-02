import { runCli, tuiOptions } from "./cli";

const argv = process.argv.slice(2);
const exitCode = await runCli(argv);
if (exitCode !== undefined) process.exit(exitCode);

// Some GUI launchers and agent hosts preserve Kitty's window identity while replacing TERM with "dumb". Restore the
// real terminal type so OpenTUI can negotiate keyboard and graphics capabilities.
if (process.env.TERM === "dumb" && process.env.KITTY_WINDOW_ID) process.env.TERM = "xterm-kitty";
// OSC 66 explicit-width wrappers can split Kitty's image placeholder graphemes.
process.env.OPENTUI_FORCE_EXPLICIT_WIDTH = "false";

const { runTui } = await import("./tui/run");
process.exit(await runTui(tuiOptions(argv)));
