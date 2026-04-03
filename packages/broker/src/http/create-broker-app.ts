import Fastify from "fastify";
import { brokerStatusSchema } from "@ai-whisper/shared";

export function createBrokerApp(input: {
	getStatus: () => {
		version: 1;
		status: "healthy" | "degraded" | "offline";
		storage: {
			driver: "sqlite";
			path: string;
			migrated: boolean;
		};
	};
}) {
	const app = Fastify({
		logger: false,
	});

	app.get("/health", () => ({ ok: true }));

	app.get("/status", () => brokerStatusSchema.parse(input.getStatus()));

	return app;
}
