import { Command } from "commander";

export function createCli(): Command {
  return new Command().name("whisper").description("ai-whisper CLI");
}
