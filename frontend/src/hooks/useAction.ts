import { useRef, useState } from "react";
export function useAction(after?: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const locked = useRef(false);
  async function run(operation: () => Promise<unknown>, message = "") {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
      if (after) await after();
      setNotice(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action failed.");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  return { busy, error, notice, run };
}
