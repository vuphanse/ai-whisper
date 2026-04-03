export type LaunchMode = "tmux" | "terminals";

export function chooseLaunchMode(input: {
  tmuxAvailable: boolean;
  forceNoTmux: boolean;
}): LaunchMode {
  if (input.tmuxAvailable && !input.forceNoTmux) {
    return "tmux";
  }

  return "terminals";
}
