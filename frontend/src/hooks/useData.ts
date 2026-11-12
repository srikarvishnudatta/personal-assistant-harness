import { useCallback, useEffect, useState } from "react";
import type { Api, Item } from "../api/client";
export function useData(api: Api, path: string) {
  const [data, setData] = useState<Item>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    try {
      setData(await api(path));
    } catch (e) {
      setError(String(e));
    }
  }, [api, path]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { data, error, busy, reload, run };
}
