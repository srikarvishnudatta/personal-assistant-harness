import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { type Api, type Item } from "../../api/client";
import { text, rows } from "../../lib/knowledge";
import { useData } from "../../hooks/useData";
import { ErrorNotice } from "../../components/ErrorNotice";

export function HistoryExplorer({ api }: { api: Api }) {
  const state = useData(api, "/history/index");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<Item | null>(null);
  return (
    <>
      <ErrorNotice value={state.error} />
      <section className="section-card knowledge-card">
        <h2>Search every retained conversation</h2>
        <p>
          Every message is indexed locally, including history older than the
          recent context window. Search by meaning uses GPT-6 Luna query
          expansion and ranking; it makes up to two extra model calls.
        </p>
        <p>
          {text(state.data.indexedMessages)} indexed messages · SQLite full-text
          index, no additional embedding model.
        </p>
        <div className="stack-form">
          <label className="native-field">
            What are you looking for?
            <input
              value={query}
              maxLength={1000}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="button-row">
            <Button
              label="Keyword search"
              variant="secondary"
              isDisabled={state.busy || !query.trim()}
              onClick={() =>
                void state.run(async () =>
                  setResult(
                    await api("/history/search", { query, semantic: false }),
                  ),
                )
              }
            />
            <Button
              label="Search by meaning"
              variant="primary"
              isDisabled={state.busy || !query.trim()}
              onClick={() =>
                void state.run(async () =>
                  setResult(
                    await api("/history/search", { query, semantic: true }),
                  ),
                )
              }
            />
          </div>
        </div>
      </section>
      {result && (
        <section className="record-list">
          <p className="section-description">{text(result.limitation)}</p>
          {rows(result.messages).map((m) => (
            <article className="record" key={text(m.id)}>
              <div className="record-body">
                <h3>
                  {text(m.role)} ·{" "}
                  {new Date(Number(m.createdAt)).toLocaleString()}
                </h3>
                <p className="break-text">{text(m.excerpt)}</p>
                <code>message:{text(m.id)}</code>
              </div>
            </article>
          ))}
          {!rows(result.messages).length && (
            <p>No matching retained messages.</p>
          )}
        </section>
      )}
    </>
  );
}
