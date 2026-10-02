import { z } from "zod";

export const mcpConfigSchema = z.object({
  MCP_PORT: z.coerce.number().int().min(1).max(65_535),
  MCP_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
});

export type McpConfig = z.infer<typeof mcpConfigSchema>;
