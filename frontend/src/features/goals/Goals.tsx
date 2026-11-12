import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { type Api } from "../../api/client";
import { txt, obj, list } from "../../lib/format";
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

export function Goals({ api }: { api: Api }) {
  const resource = useResource(api, "/goals");
  const action = useAction(resource.reload);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState("");
  const items = list(resource.data, "goals");
  const save = () =>
    void action.run(async () => {
      await api("/goals", {
        title: title.trim(),
        description: description.trim(),
        steps: steps
          .split("\n")
          .map((step) => step.trim())
          .filter(Boolean),
      });
      setTitle("");
      setDescription("");
      setSteps("");
    });
  return (
    <>
      <Feedback
        loading={resource.loading}
        error={resource.error || action.error}
        notice={action.notice}
      />
      <Card
        title="Choose a direction"
        actions={<Refresh reload={resource.reload} />}
      >
        <form
          className="stack-form"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <TextInput
            label="Goal"
            value={title}
            onChange={setTitle}
            placeholder="Prepare for my next interview"
          />
          <Area
            label="What success looks like"
            value={description}
            onChange={setDescription}
            rows={2}
          />
          <Area
            label="Starting steps (one per line, optional)"
            value={steps}
            onChange={setSteps}
            rows={3}
          />
          <Button
            label="Create goal"
            variant="primary"
            isDisabled={action.busy || !title.trim()}
            onClick={save}
          />
        </form>
      </Card>
      <section className="record-list">
        {!items.length && !resource.loading && (
          <Empty title="A clear direction starts here.">
            Create a goal, then ask your assistant to advance it.
          </Empty>
        )}
        {items.map((item) => (
          <article className="record" key={txt(item.id)}>
            <div className="record-body">
              <div className="task-heading">
                <h3>{txt(item.title)}</h3>
                <Status value={item.status} />
              </div>
              <p>{txt(item.description)}</p>
              {Array.isArray(item.steps) && (
                <ol className="goal-steps">
                  {item.steps.map((step, index) => (
                    <li key={index}>
                      {typeof step === "string"
                        ? step
                        : txt(obj(step).title ?? obj(step).text)}
                      {obj(step).status === "completed" ? " (done)" : ""}
                    </li>
                  ))}
                </ol>
              )}
              <div className="button-row">
                <Button
                  label="Advance goal"
                  variant="primary"
                  isDisabled={action.busy || item.status === "completed"}
                  onClick={() =>
                    void action.run(
                      () =>
                        api(
                          `/goals/${encodeURIComponent(txt(item.id))}/run`,
                          {},
                        ),
                      "Task started. Follow its progress in Tasks.",
                    )
                  }
                />
                <Button
                  label="Mark complete"
                  variant="secondary"
                  isDisabled={action.busy || item.status === "completed"}
                  onClick={() =>
                    void action.run(() =>
                      api(
                        `/goals/${encodeURIComponent(txt(item.id))}`,
                        { status: "completed" },
                        "PATCH",
                      ),
                    )
                  }
                />
              </div>
            </div>
          </article>
        ))}
      </section>
    </>
  );
}
