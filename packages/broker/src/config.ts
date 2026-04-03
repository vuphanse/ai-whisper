import { z } from "zod";

export const brokerConfigSchema = z.object({
  sqlitePath: z.string().min(1),
  host: z.string().min(1).default("127.0.0.1"),
  port: z.number().int().positive().default(4311),
});

export type BrokerConfig = z.infer<typeof brokerConfigSchema>;
