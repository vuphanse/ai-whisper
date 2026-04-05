import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const attachSessionBinPath = resolve(__dirname, "../bin/attach-session.js");

export function renderAttachSnippet(input: {
	target: "codex" | "claude";
	workspaceRoot: string;
	claimId: string;
	secret: string;
}) {
	const base = `${JSON.stringify(process.execPath)} ${JSON.stringify(attachSessionBinPath)} ${input.target}`;
	return `${base} --workspace ${JSON.stringify(input.workspaceRoot)} --claim-id ${input.claimId} --secret ${input.secret}`;
}
