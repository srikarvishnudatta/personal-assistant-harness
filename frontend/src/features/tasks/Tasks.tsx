import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { type Api } from "../../api/client";
import { txt, list, time } from "../../lib/format";
import { useResource } from "../../hooks/useResource";
import { useAction } from "../../hooks/useAction";
import { Empty, Card, Status, Feedback, Area } from "../../components/ui";
import { type View } from "../../app/navigation";

export function Tasks({
  api,
  navigate,
}: {
  api: Api;
  navigate: (view: View) => void;
}) {
  const resource = useResource(api, "/tasks", true);
  const action = useAction(resource.reload);
  const [prompt, setPrompt] = useState("");
  const [editing, setEditing] = useState("");
  const [memory, setMemory] = useState("");
  const items = list(resource.data, "tasks");
  return (
    <>
      <Feedback
        loading={resource.loading}
        error={resource.error || action.error}
      />
      <Card
        title="Keep the work moving"
        actions={
          <Button
            label="Run a dream"
            variant="secondary"
            isDisabled={action.busy}
            onClick={() =>
              void action.run(() =>
                api("/tasks", {
                  kind: "dream",
                  prompt:
                    "Consolidate recent activity into evidence-backed memories.",
                }),
              )
            }
          />
        }
      >
        <div className="inline-form">
          <TextInput
            label="Background task"
            value={prompt}
            onChange={setPrompt}
            placeholder="Review my saved context and suggest priorities"
          />
          <Button
            label="Start task"
            variant="primary"
            isDisabled={action.busy || !prompt.trim()}
            onClick={() =>
              void action.run(async () => {
                await api("/tasks", { kind: "task", prompt: prompt.trim() });
                setPrompt("");
              })
            }
          />
        </div>
      </Card>
      <section className="record-list">
        {!items.length && !resource.loading && (
          <Empty title="A clear slate.">
            Background tasks and dream results appear here.
          </Empty>
        )}
        {items.map((item) => (
          <article className="record" key={txt(item.id)}>
            <div className="record-body">
              <div className="task-heading">
                <p>{txt(item.prompt)}</p>
                <Status value={item.status} />
              </div>
              <div className="record-meta">
                <span>{txt(item.kind)}</span>
                <span>{time(item.createdAt ?? item.created_at)}</span>
                {Boolean(item.goalId) && <span>Goal: {txt(item.goalId)}</span>}
              </div>
              {Boolean(item.result) && (
                <details>
                  <summary>View result</summary>
                  <pre>{txt(item.result)}</pre>
                </details>
              )}
              {Boolean(item.error) && (
                <p className="task-error">{txt(item.error)}</p>
              )}
              {item.status === "waiting_approval" && (
                <Button
                  label="Review pending actions"
                  variant="secondary"
                  onClick={() => navigate("Approvals")}
                />
              )}
              {item.kind === "dream" &&
                item.status === "completed" &&
                Boolean(item.result) && (
                  <div className="dream-review">
                    <Button
                      label="Review memory proposal"
                      variant="secondary"
                      onClick={() => {
                        setEditing(txt(item.id));
                        setMemory(txt(item.result));
                      }}
                    />
                    {editing === txt(item.id) && (
                      <div className="review-form">
                        <Area
                          label="Edit the memory to keep"
                          value={memory}
                          onChange={setMemory}
                          maxLength={2000}
                        />
                        <p>
                          This saves your reviewed text. If memory changed after
                          the dream, generate a fresh proposal.
                        </p>
                        <Button
                          label="Save reviewed memory"
                          variant="primary"
                          isDisabled={action.busy || !memory.trim()}
                          onClick={() =>
                            void action.run(async () => {
                              await api("/dreams/apply", {
                                taskId: txt(item.id),
                                text: memory.trim(),
                              });
                              setEditing("");
                              setMemory("");
                            })
                          }
                        />
                      </div>
                    )}
                  </div>
                )}
            </div>
          </article>
        ))}
      </section>
    </>
  );
}
