import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { type Api } from "../../api/client";
import { txt, obj, list, time } from "../../lib/format";
import { useResource } from "../../hooks/useResource";
import { useAction } from "../../hooks/useAction";
import {
  Empty,
  Card,
  Status,
  Feedback,
  Area,
  Refresh,
} from "../../components/ui";

export function Workflows({ api }: { api: Api }) {
  const resource = useResource(api, "/workflows", true);
  const action = useAction(resource.reload);
  const [prompt, setPrompt] = useState("");
  const [assignments, setAssignments] = useState(
    "Investigate the primary evidence and cite sources.\nInvestigate alternatives, risks and conflicting evidence.",
  );
  const specialists = assignments
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const items = list(resource.data, "workflows");
  return (
    <>
      <Feedback
        loading={resource.loading}
        error={resource.error || action.error}
      />
      <Card
        title="Give a team a goal"
        actions={<Refresh reload={resource.reload} />}
      >
        <div className="stack-form">
          <Area
            label="What should the team accomplish?"
            value={prompt}
            onChange={setPrompt}
            maxLength={6000}
          />
          <Area
            label="Specialist assignments — one per line (2–4)"
            value={assignments}
            onChange={setAssignments}
            maxLength={12000}
          />
          <p>
            Specialists work in parallel. A verifier reviews their findings,
            then a synthesizer writes one answer. All agents use GPT-6 Luna with
            read-only tools. Results arrive in Inbox.
          </p>
          <Button
            label="Start workflow"
            variant="primary"
            isDisabled={
              action.busy ||
              !prompt.trim() ||
              specialists.length < 2 ||
              specialists.length > 4
            }
            onClick={() =>
              void action.run(async () => {
                await api("/workflows", {
                  prompt: prompt.trim(),
                  specialists: specialists.map((assignment, index) => ({
                    role: `Specialist ${index + 1}`,
                    prompt: assignment,
                  })),
                });
                setPrompt("");
              })
            }
          />
        </div>
      </Card>
      <section className="record-list">
        {!items.length && !resource.loading && (
          <Empty title="Your team is ready.">
            Start a workflow to follow each agent and its dependencies here.
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
                <span>{time(item.createdAt)}</span>
                <span>GPT-6 Luna · up to 2 agents concurrently</span>
              </div>
              {list(item, "nodes").map((node) => {
                const task = obj(node.task);
                return (
                  <details key={txt(node.id)}>
                    <summary>
                      {txt(node.role)} · {txt(task.status)}
                      {task.status === "queued"
                        ? " (waiting for dependencies or a free slot)"
                        : ""}
                    </summary>
                    <p>Assignment: {txt(node.prompt)}</p>
                    <p>
                      Depends on:{" "}
                      {Array.isArray(node.dependsOn) && node.dependsOn.length
                        ? node.dependsOn.map(txt).join(", ")
                        : "none"}
                    </p>
                    <p>Attempts: {txt(task.attempts)}</p>
                    {Boolean(task.result) && <pre>{txt(task.result)}</pre>}
                    {Boolean(task.error) && (
                      <p className="task-error">{txt(task.error)}</p>
                    )}
                  </details>
                );
              })}
              {Boolean(item.result) && (
                <details open>
                  <summary>Final answer</summary>
                  <pre>{txt(item.result)}</pre>
                </details>
              )}
              {Boolean(item.error) && (
                <p className="task-error">{txt(item.error)}</p>
              )}
              {item.status === "failed" && (
                <Button
                  label="Retry failed agents"
                  variant="secondary"
                  isDisabled={action.busy}
                  onClick={() =>
                    void action.run(() =>
                      api(
                        `/workflows/${encodeURIComponent(txt(item.id))}/retry`,
                        {},
                      ),
                    )
                  }
                />
              )}
              {!["completed", "cancelled"].includes(txt(item.status)) && (
                <Button
                  label="Cancel workflow"
                  variant="secondary"
                  isDisabled={action.busy}
                  onClick={() =>
                    void action.run(() =>
                      api(
                        `/workflows/${encodeURIComponent(txt(item.id))}/cancel`,
                        {},
                      ),
                    )
                  }
                />
              )}
            </div>
          </article>
        ))}
      </section>
    </>
  );
}
