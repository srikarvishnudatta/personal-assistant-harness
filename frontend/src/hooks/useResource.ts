import { useCallback, useEffect, useRef, useState } from "react";
import type { Api, Item } from "../api/client";
export function useResource(api: Api, path: string, poll = false) {
  const [data, setData] = useState<Item>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const reload = useCallback(
    async (silent = false) => {
      const current = ++generation.current;
      if (!silent) {
        setLoading(true);
        setError("");
      }
      try {
        const data = await api(path);
        if (current === generation.current) {
          setData(data);
          setError("");
        }
      } catch (cause) {
        if (current === generation.current)
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not load this view.",
          );
      } finally {
        if (current === generation.current) setLoading(false);
      }
    },
    [api, path],
  );
  useEffect(() => {
    setData({});
    void reload();
    const timer = poll ? setInterval(() => void reload(true), 5000) : undefined;
    return () => {
      generation.current++;
      if (timer) clearInterval(timer);
    };
  }, [reload, poll]);
  return { data, loading, error, reload };
}
