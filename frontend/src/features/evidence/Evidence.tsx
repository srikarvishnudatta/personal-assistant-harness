import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { type Api, type Item } from "../../api/client";
import { text, rows, pretty } from "../../lib/knowledge";
import { useData } from "../../hooks/useData";
import { ErrorNotice } from "../../components/ErrorNotice";

export function Evidence({ api }: { api: Api }) {
  const state = useData(api, "/freshness");
  const [value, setValue] = useState("");
  const [report, setReport] = useState<Item | null>(null);
  return (
    <>
      <ErrorNotice value={state.error} />
      <section className="section-card knowledge-card">
        <h2>Freshness and claim support</h2>
        <p>
          Changes-only research updates are re-read before delivery. Each source
          has its own observation time and content fingerprint. Luna reviews
          material claims against bounded excerpts; this is support review, not
          independent fact verification.
        </p>
        <p>
          Checking may open up to six temporary public browser tabs and make one
          model call. Failed, stale, incomplete or unsupported reviews hold the
          update and open a repair thread. A recent fetch does not prove a
          recent publication.
        </p>
        <div className="stack-form">
          <label className="native-field">
            Proposed update with source links
            <textarea
              value={value}
              maxLength={24000}
              rows={5}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <Button
            label="Re-read sources and review claims"
            variant="primary"
            isDisabled={state.busy || !value.trim()}
            onClick={() =>
              void state.run(async () =>
                setReport(await api("/freshness/verify", { text: value })),
              )
            }
          />
        </div>
        {report && <pre>{pretty(report)}</pre>}
      </section>
      {rows(state.data.reports).map((r) => (
        <section className="section-card knowledge-card" key={text(r.id)}>
          <h3>
            {r.selected ? "Support review passed" : "Update held"} ·{" "}
            {new Date(Number(r.checkedAt)).toLocaleString()}
          </h3>
          <code>report:{text(r.id)}</code>
          <details>
            <summary>Claims, sources and decision</summary>
            <pre>{pretty(r)}</pre>
          </details>
        </section>
      ))}
    </>
  );
}
