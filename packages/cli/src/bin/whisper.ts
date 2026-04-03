#!/usr/bin/env node
import { createCli } from "../create-cli.js";

await createCli().parseAsync(process.argv);
