/** HTTP boundary between the UI and the independently running Python API. */
export type Item = Record<string, unknown>;
export type Api = (
  path: string,
  body?: unknown,
  method?: string,
) => Promise<Item>;

export function createApi(token: string): Api {
  return async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    let data: Item;
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      data =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Item)
          : {};
    } catch {
      throw new Error("The server returned an unreadable response.");
    }
    if (!response.ok) {
      throw new Error(
        typeof data.error === "string"
          ? data.error
          : `Request failed (${response.status}).`,
      );
    }
    return data;
  };
}
