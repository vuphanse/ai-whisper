import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

export interface WorkspaceHeadReader {
	readHead(workspaceRoot: string): Promise<string>;
}

export function createWorkspaceHeadReader(): WorkspaceHeadReader {
	return {
		async readHead(workspaceRoot: string): Promise<string> {
			const { stdout } = await pExecFile(
				"git",
				["-C", workspaceRoot, "rev-parse", "HEAD"],
				{ timeout: 5_000 },
			);
			return stdout.trim();
		},
	};
}
