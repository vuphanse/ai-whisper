/**
 * Loads variables from a .env file in the current working directory into
 * process.env. Silently skips if the file does not exist — .env is optional.
 */
export function loadDotEnv(): void {
	try {
		process.loadEnvFile();
	} catch (error: unknown) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return;
		}
		throw error;
	}
}
