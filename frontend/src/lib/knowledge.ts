import type { Item } from "../api/client";
export const text = (v: unknown) =>
  typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
export const rows = (v: unknown): Item[] =>
  Array.isArray(v) ? (v as Item[]) : [];
export const pretty = (v: unknown) => JSON.stringify(v, null, 2);
export const ids = (v: string) =>
  v
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
