// Enable ANSI color output during tests so dashboard-view tests can
// inspect SGR sequences without depending on the terminal type.
process.env.FORCE_COLOR = process.env.FORCE_COLOR ?? "3";
