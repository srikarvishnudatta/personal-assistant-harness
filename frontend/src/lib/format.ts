import type { Item } from "../api/client";
export const txt = (value: unknown): string =>
  typeof value === "string"
    ? value
    : value == null
      ? ""
      : JSON.stringify(value);
export const obj = (value: unknown): Item =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Item)
    : {};
export const pretty = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
export function list(data: Item, key: string): Item[] {
  const value = data[key] ?? data.items ?? data.entries;
  return Array.isArray(value)
    ? value.map((value) =>
        typeof value === "string" ? { path: value, name: value } : obj(value),
      )
    : [];
}
export function time(value: unknown): string {
  if (!value) return "Not recorded";
  const date = new Date(typeof value === "number" ? value : String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
