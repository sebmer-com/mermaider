import { z } from "zod";
import type { Config } from "./types.js";

const path = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p
        .split("/")
        .some((s) => s === "" || s === "." || s === ".." || s === ".git"),
    "Use a canonical repository-relative path outside .git",
  );
export const configSchema = z
  .object({
    version: z.literal(1),
    include: z.array(z.string()).default(["**/*"]),
    exclude: z.array(z.string()).default([]),
    outputDir: path.default("docs/mermaider"),
    html: path
      .refine((p) => p.endsWith(".html"), "HTML output must end in .html")
      .optional(),
    audience: z.enum(["overview", "technical", "both"]).optional(),
    detail: z.enum(["overview", "detailed", "both"]).optional(),
    diagrams: z.array(
      z
        .object({
          id: z.string().min(1),
          title: z.string().optional(),
          navLabel: z.string().min(1).max(64).optional(),
          model: path.optional(),
          audience: z.enum(["overview", "technical", "both"]).optional(),
          detail: z.enum(["overview", "detailed", "both"]).optional(),
          focus: z.array(z.string()).optional(),
          attributes: z.enum(["all", "keys", "none"]).optional(),
          output: z
            .object({
              markdown: path,
              mermaid: path.optional(),
              block: z
                .string()
                .regex(/^[a-zA-Z0-9_-]+$/)
                .optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    ),
    hooks: z
      .object({
        enabled: z.boolean().default(true),
        trigger: z.enum(["commit", "changes"]).default("changes"),
      })
      .strict()
      .default({ enabled: true, trigger: "changes" }),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (new Set(c.diagrams.map((d) => d.id)).size !== c.diagrams.length)
      ctx.addIssue({ code: "custom", message: "Diagram IDs must be unique" });
  });
export function parseConfig(value: unknown): Config {
  return configSchema.parse(value);
}
export const defaultConfig = (): Config =>
  parseConfig({ version: 1, diagrams: [] });
