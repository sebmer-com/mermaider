import { createHash } from "node:crypto";
export const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
export const stableId = (prefix: string, value: string): string =>
  `${prefix}_${sha256(value).slice(0, 12)}`;
export function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b, "en"))
              .map(([k, x]) => [k, sort(x)]),
          )
        : v;
  return JSON.stringify(sort(value), null, 2) + "\n";
}
