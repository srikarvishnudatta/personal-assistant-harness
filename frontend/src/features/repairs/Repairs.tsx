import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { type Api, type Item } from "../../api/client";
import { text, rows, pretty, ids } from "../../lib/knowledge";
import { useData } from "../../hooks/useData";
import { ErrorNotice } from "../../components/ErrorNotice";

export function Repairs({ api }: { api: Api }) {
  const state = useData(api, "/repairs");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  return (
    <>
      <ErrorNotice value={state.error} />
      <section className="section-card knowledge-card">
        <h2>Repair threads</h2>
        <p>
          Corrections, task failures and held source checks create inspectable
          repair threads. Reviewing a repair never retries an action or sends a
          notification by itself.
        </p>
        <div className="stack-form">
          <label className="native-field">
            Subject
            <input
              value={subject}
              maxLength={300}
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>
          <label className="native-field">
            What needs repair?
            <textarea
              value={description}
              maxLength={6000}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <Button
            label="Open repair"
            variant="secondary"
            isDisabled={state.busy || !subject.trim() || !description.trim()}
            onClick={() =>
              void state.run(async () => {
                await api("/repairs", { kind: "other", subject, description });
                setSubject("");
                setDescription("");
              })
            }
          />
        </div>
      </section>
      {rows(state.data.repairs).map((r) => (
        <RepairCard key={text(r.id)} item={r} api={api} reload={state.reload} />
      ))}
    </>
  );
}

function RepairCard({
  item,
  api,
  reload,
}: {
  item: Item;
  api: Api;
  reload: () => Promise<void>;
}) {
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const allowed: Record<string, string[]> = {
    open: ["reviewing", "dismissed"],
    reviewing: ["resolved", "dismissed", "open"],
    resolved: ["open"],
    dismissed: ["open"],
  };
  const update = async (status: string) => {
    setBusy(true);
    setError("");
    try {
      await api(
        `/repairs/${text(item.id)}`,
        {
          status,
          resolution: note,
          evidence: ids(evidence),
          expectedRevision: item.revision,
        },
        "PATCH",
      );
      await reload();
      setNote("");
      setEvidence("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="section-card knowledge-card">
      <h3>
        {text(item.subject)} · {text(item.status)}
      </h3>
      <p>{text(item.description)}</p>
      <small>
        {text(item.kind)} · revision {text(item.revision)}
      </small>
      {Boolean(item.resolution) && <p>Review note: {text(item.resolution)}</p>}
      <pre>{pretty(item.evidence)}</pre>
      <ErrorNotice value={error} />
      <div className="stack-form">
        <label className="native-field">
          Review note / resolution
          <textarea
            value={note}
            maxLength={4000}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <label className="native-field">
          Evidence references, comma separated
          <input
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            placeholder="task:ID, memory:ID, report:ID, https://source…"
          />
        </label>
        <div className="button-row">
          {(allowed[text(item.status)] || []).map((s) => (
            <Button
              key={s}
              label={
                s === "open"
                  ? "Reopen"
                  : s === "reviewing"
                    ? "Start review"
                    : s === "resolved"
                      ? "Resolve with evidence"
                      : "Dismiss with note"
              }
              variant="secondary"
              isDisabled={
                busy || !note.trim() || (s === "resolved" && !evidence.trim())
              }
              onClick={() => void update(s)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
