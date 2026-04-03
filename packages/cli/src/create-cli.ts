import { Command } from "commander";

export function createCli(): Command {
  const cli = new Command().name("whisper").description("ai-whisper CLI");
  cli.command("collab");
  return cli;
}
