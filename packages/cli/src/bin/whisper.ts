#!/usr/bin/env node
import { loadDotEnv } from "../runtime/load-dot-env.js";
import { createCli } from "../create-cli.js";

loadDotEnv();
await createCli().parseAsync(process.argv);
