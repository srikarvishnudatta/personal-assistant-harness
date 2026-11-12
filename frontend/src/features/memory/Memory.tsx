import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { type Api, type Item } from "../../api/client";
import { txt, obj, pretty, list, time } from "../../lib/format";
import { useResource } from "../../hooks/useResource";
import { useAction } from "../../hooks/useAction";
import { Empty, Card, Status, Feedback, Refresh } from "../../components/ui";

export function Memory({ api }: { api: Api }) {
  const resource = useResource(api, "/memories");
  const action = useAction(resource.reload);
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState("");
  const [kind, setKind] = useState("fact");
  const [query, setQuery] = useState("");
  const [searchResult, setSearchResult] = useState<Item | null>(null);
  const [lineage, setLineage] = useState<Item[] | null>(null);
  const items = list(searchResult ?? resource.data, "memories");
  const save = () =>
    void action.run(async () => {
      await api(
        editing ? `/memories/${encodeURIComponent(editing)}` : "/memories",
        { text: value.trim(), kind },
        editing ? "PATCH" : "POST",
      );
      setEditing("");
      setValue("");
      setSearchResult(null);
    });
  return (
    <>
      <Feedback
        loading={resource.loading}
        error={resource.error || action.error}
        notice={action.notice}
      />
      <Card
        title="Find and inspect memory"
        actions={<Refresh reload={resource.reload} />}
      >
        <div className="inline-form">
          <TextInput
            label="Search saved memories"
            value={query}
            onChange={setQuery}
            placeholder="Preferences, people, projects or commitments"
          />
          <Button
            label="Search"
            variant="secondary"
            isDisabled={action.busy || !query.trim()}
            onClick={() =>
              void action.run(async () =>
                setSearchResult(
                  await api("/memory/search", { query, semantic: false }),
                ),
              )
            }
          />
          <Button
            label="Search by meaning"
            variant="secondary"
            isDisabled={action.busy || !query.trim()}
            onClick={() =>
              void action.run(async () =>
                setSearchResult(
                  await api("/memory/search", { query, semantic: true }),
                ),
              )
            }
          />
          <Button
            label="Show all"
            variant="ghost"
            onClick={() => setSearchResult(null)}
          />
        </div>
        <p className="section-description">
          Search by meaning uses GPT-6 Luna and counts toward the token budget.
          Source links and previous revisions are available through Lineage.
        </p>
        <Button
          label="Refresh readable memory files"
          variant="secondary"
          isDisabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              const result = await api("/memory/files");
              if (result.error) throw new Error(txt(result.error));
            }, "Readable memory files refreshed. Open memory/MEMORY.md in Files.")
          }
        />
      </Card>
      <Card title={editing ? "Correct a memory" : "Keep something in mind"}>
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <TextInput
            label="Fact or preference"
            value={value}
            onChange={setValue}
            placeholder="I prefer short, visual explanations"
          />
          <label className="native-field">
            Kind
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              {[
                "fact",
                "preference",
                "person",
                "project",
                "goal",
                "commitment",
              ].map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <div className="button-row">
            <Button
              label={editing ? "Save correction" : "Save memory"}
              variant="primary"
              isDisabled={action.busy || !value.trim()}
              onClick={save}
            />
            {editing && (
              <Button
                label="Cancel"
                variant="ghost"
                onClick={() => {
                  setEditing("");
                  setValue("");
                }}
              />
            )}
          </div>
        </form>
      </Card>
      {lineage && (
        <Card title="Claim lineage">
          <Button
            label="Close lineage"
            variant="ghost"
            onClick={() => setLineage(null)}
          />
          <pre>{pretty(lineage)}</pre>
        </Card>
      )}
      <section className="record-list">
        {!items.length && !resource.loading && (
          <Empty title="No matching memories.">
            Saved facts and preferences appear here with their sources.
          </Empty>
        )}
        {items.map((item) => (
          <article className="record" key={txt(item.id)}>
            <div className="record-body">
              <p>{txt(item.text)}</p>
              <div className="record-meta">
                <Status value={item.provenance} />
                <span>{txt(item.kind)}</span>
                <span>{time(item.updatedAt)}</span>
              </div>
              <small>Source: {txt(item.source)}</small>
            </div>
            <div className="button-column">
              <Button
                label="Lineage"
                variant="ghost"
                isDisabled={action.busy}
                onClick={() =>
                  void action.run(async () =>
                    setLineage(
                      list(
                        await api(
                          `/memories/${encodeURIComponent(txt(item.id))}/lineage`,
                        ),
                        "lineage",
                      ),
                    ),
                  )
                }
              />
              <Button
                label="Edit"
                variant="ghost"
                isDisabled={action.busy}
                onClick={() => {
                  setEditing(txt(item.id));
                  setValue(txt(item.text));
                  setKind(txt(item.kind) || "fact");
                }}
              />
              <Button
                label="Forget saved memory"
                variant="ghost"
                isDisabled={action.busy}
                onClick={() =>
                  void action.run(async () => {
                    const report = await api(
                      `/memories/${encodeURIComponent(txt(item.id))}`,
                      undefined,
                      "DELETE",
                    );
                    setSearchResult(null);
                    setLineage(null);
                    if (obj(report.projection).error)
                      throw new Error(
                        "Saved memory removed, but readable files could not refresh; stale managed files are blocked. Source chat is retained.",
                      );
                  }, "Saved memory and known managed copies removed. Source chat and unrelated artifacts are retained.")
                }
              />
            </div>
          </article>
        ))}
      </section>
    </>
  );
}
