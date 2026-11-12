import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { type Api, type Item } from "../../api/client";
import { text, rows, pretty, ids } from "../../lib/knowledge";
import { useData } from "../../hooks/useData";
import { ErrorNotice } from "../../components/ErrorNotice";

export function People({ api }: { api: Api }) {
  const state = useData(api, "/people");
  const [editing, setEditing] = useState<Item | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState("person");
  const [aliases, setAliases] = useState("");
  const [context, setContext] = useState("");
  const [sources, setSources] = useState("user");
  const [source, setSource] = useState("");
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [edgeSources, setEdgeSources] = useState("user");
  const people = rows(state.data.people);
  const relationships = rows(state.data.relationships);
  const reset = () => {
    setEditing(null);
    setName("");
    setKind("person");
    setAliases("");
    setContext("");
    setSources("user");
  };
  const edit = (p: Item) => {
    setEditing(p);
    setName(text(p.name));
    setKind(text(p.kind));
    setAliases((p.aliases as string[]).join(", "));
    setContext(text(p.context));
    setSources((p.sourceIds as string[]).join(", "));
  };
  const nameOf = (id: unknown) =>
    text(people.find((p) => p.id === id)?.name) || text(id);
  return (
    <>
      <ErrorNotice value={state.error} />
      <section className="section-card knowledge-card">
        <h2>{editing ? "Correct a person or group" : "People and groups"}</h2>
        <p>
          Entries are reviewed facts with source IDs. The assistant can retrieve
          relevant relationships; it does not automatically infer identities or
          merge people who share a name.
        </p>
        <div className="stack-form">
          <label className="native-field">
            Name
            <input
              value={name}
              maxLength={160}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="native-field">
            Type
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="person">Person</option>
              <option value="group">Group</option>
            </select>
          </label>
          <label className="native-field">
            Aliases, comma separated
            <input
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
            />
          </label>
          <label className="native-field">
            Context
            <textarea
              value={context}
              maxLength={6000}
              onChange={(e) => setContext(e.target.value)}
              rows={3}
            />
          </label>
          <label className="native-field">
            Source message/memory IDs, or user for your direct entry
            <input
              value={sources}
              onChange={(e) => setSources(e.target.value)}
            />
          </label>
          <div className="button-row">
            <Button
              label={editing ? "Save correction" : "Save reviewed entry"}
              variant="primary"
              isDisabled={state.busy || !name.trim()}
              onClick={() =>
                void state.run(async () => {
                  await api(
                    editing ? `/people/${text(editing.id)}` : "/people",
                    {
                      name,
                      kind,
                      aliases: ids(aliases),
                      context,
                      sourceIds: ids(sources),
                      ...(editing
                        ? { expectedRevision: editing.revision }
                        : {}),
                    },
                    editing ? "PATCH" : "POST",
                  );
                  reset();
                })
              }
            />
            {editing && (
              <Button
                label="Cancel editing"
                variant="secondary"
                onClick={reset}
              />
            )}
          </div>
        </div>
      </section>
      <section className="record-list">
        {people.map((p) => (
          <article className="record" key={text(p.id)}>
            <div className="record-body">
              <h3>
                {text(p.name)}{" "}
                <small>
                  {text(p.kind)} · revision {text(p.revision)}
                </small>
              </h3>
              <p>{text(p.context)}</p>
              {Boolean(p.needsReview) && (
                <p className="task-error">
                  A source was corrected. Review this entry before it is used in
                  agent context.
                </p>
              )}
              <p>Aliases: {text(p.aliases)}</p>
              <details>
                <summary>Provenance</summary>
                <pre>{pretty(p.sourceIds)}</pre>
                <code>{text(p.id)}</code>
              </details>
              <div className="button-row spaced">
                <Button
                  label="Edit"
                  variant="secondary"
                  onClick={() => edit(p)}
                />
                <Lineage api={api} id={text(p.id)} />
                <Button
                  label="Remove graph entry"
                  variant="ghost"
                  isDisabled={state.busy}
                  onClick={() =>
                    void state.run(() =>
                      api(`/people/${text(p.id)}`, undefined, "DELETE"),
                    )
                  }
                />
              </div>
            </div>
          </article>
        ))}
      </section>
      <section className="section-card knowledge-card">
        <h2>Relationships</h2>
        <p>
          Links are directed. Removing a graph entry removes its links and graph
          revision history; retained chat and saved memories remain separate.
        </p>
        <div className="stack-form">
          <label className="native-field">
            From
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Choose an entry</option>
              {people.map((p) => (
                <option key={text(p.id)} value={text(p.id)}>
                  {text(p.name)} · {text(p.id).slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label className="native-field">
            Relationship
            <input
              value={label}
              maxLength={120}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="member of, colleague of, friend of"
            />
          </label>
          <label className="native-field">
            To
            <select value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose an entry</option>
              {people.map((p) => (
                <option key={text(p.id)} value={text(p.id)}>
                  {text(p.name)} · {text(p.id).slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label className="native-field">
            Relationship source IDs
            <input
              value={edgeSources}
              onChange={(e) => setEdgeSources(e.target.value)}
            />
          </label>
          <Button
            label="Add reviewed relationship"
            variant="primary"
            isDisabled={
              state.busy ||
              !source ||
              !target ||
              source === target ||
              !label.trim()
            }
            onClick={() =>
              void state.run(async () => {
                await api("/people/relationships", {
                  source,
                  target,
                  label,
                  sourceIds: ids(edgeSources),
                });
                setLabel("");
              })
            }
          />
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>From</th>
                <th>Relationship</th>
                <th>To</th>
                <th>Source / action</th>
              </tr>
            </thead>
            <tbody>
              {relationships.map((e) => (
                <tr key={text(e.id)}>
                  <td>{nameOf(e.source)}</td>
                  <td>
                    {text(e.label)}
                    {Boolean(e.needsReview) && (
                      <p className="task-error">
                        Source changed: remove and re-add the reviewed
                        relationship.
                      </p>
                    )}
                  </td>
                  <td>{nameOf(e.target)}</td>
                  <td>
                    {text(e.sourceIds)}{" "}
                    <Button
                      label="Remove link"
                      variant="ghost"
                      onClick={() =>
                        void state.run(() =>
                          api(
                            `/people/relationships/${text(e.id)}`,
                            undefined,
                            "DELETE",
                          ),
                        )
                      }
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Lineage({ api, id }: { api: Api; id: string }) {
  const [lineage, setLineage] = useState<Item | null>(null);
  const [error, setError] = useState("");
  return (
    <div>
      <Button
        label="Revision history"
        variant="ghost"
        onClick={() =>
          void api(`/people/${id}/lineage`)
            .then(setLineage)
            .catch((e) => setError(String(e)))
        }
      />
      <ErrorNotice value={error} />
      {lineage && (
        <details open>
          <summary>Reviewed versions</summary>
          <pre>{pretty(lineage.lineage)}</pre>
        </details>
      )}
    </div>
  );
}
