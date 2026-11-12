import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { type Api, type Item } from "../../api/client";
import { txt, list, time } from "../../lib/format";
import { useResource } from "../../hooks/useResource";
import { useAction } from "../../hooks/useAction";
import { Empty, Card, Status, Feedback, Refresh } from "../../components/ui";

export function Schedules({ api }: { api: Api }) {
  const resource = useResource(api, "/schedules");
  const action = useAction(resource.reload);
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState("once");
  const [kind, setKind] = useState("task");
  const [deliveryPolicy, setDeliveryPolicy] = useState("every");
  const [runAt, setRunAt] = useState("");
  const [interval, setInterval] = useState("1440");
  const [cron, setCron] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const items = list(resource.data, "schedules");
  const save = () =>
    void action.run(async () => {
      const payload: Item = {
        prompt: prompt.trim(),
        kind,
        timezone,
        deliveryPolicy,
      };
      if (mode === "cron") payload.cron = cron;
      else {
        if (!runAt) throw new Error("Choose the first run time.");
        payload.runAt = new Date(runAt).toISOString();
        if (mode === "interval") {
          const seconds = Number(interval) * 60;
          if (!Number.isInteger(seconds) || seconds < 60)
            throw new Error("Repeat intervals must be at least one minute.");
          payload.intervalSeconds = seconds;
        }
      }
      await api("/schedules", payload);
      setPrompt("");
    });
  return (
    <>
      <Feedback
        loading={resource.loading}
        error={resource.error || action.error}
      />
      <Card
        title="Make time for it"
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
            label="What should your assistant do?"
            value={prompt}
            onChange={setPrompt}
            placeholder="Review my goals and suggest a next step"
          />
          <div className="form-columns">
            <label className="native-field">
              Schedule type
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value)}
              >
                <option value="once">One time</option>
                <option value="interval">Fixed interval</option>
                <option value="cron">Timezone-aware cron</option>
              </select>
            </label>
            <label className="native-field">
              Work type
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                <option value="task">Task</option>
                <option value="dream">Memory consolidation dream</option>
              </select>
            </label>
          </div>
          {mode === "cron" ? (
            <div className="form-columns">
              <TextInput
                label="Five-field cron"
                value={cron}
                onChange={setCron}
              />
              <TextInput
                label="IANA timezone"
                value={timezone}
                onChange={setTimezone}
              />
            </div>
          ) : (
            <div className="form-columns">
              <label className="native-field">
                First run in your local time
                <input
                  type="datetime-local"
                  value={runAt}
                  onChange={(event) => setRunAt(event.target.value)}
                  required
                />
              </label>
              {mode === "interval" && (
                <label className="native-field">
                  Repeat every (minutes)
                  <input
                    type="number"
                    min="1"
                    value={interval}
                    onChange={(event) => setInterval(event.target.value)}
                  />
                </label>
              )}
            </div>
          )}
          <label className="native-field">
            Result delivery
            <select
              value={deliveryPolicy}
              onChange={(event) => setDeliveryPolicy(event.target.value)}
            >
              <option value="every">Every run (reminders)</option>
              <option value="changes">
                Changes with fresh source observations (research)
              </option>
            </select>
          </label>
          <Button
            label="Create schedule"
            variant="primary"
            isDisabled={action.busy || !prompt.trim()}
            onClick={save}
          />
        </form>
      </Card>
      <section className="record-list">
        {!items.length && !resource.loading && (
          <Empty title="Nothing on the clock yet.">
            Add a task or a memory consolidation schedule.
          </Empty>
        )}
        {items.map((item) => (
          <article className="record" key={txt(item.id)}>
            <div className="record-body">
              <p>{txt(item.prompt)}</p>
              <div className="record-meta">
                <Status value={item.status} />
                <span>
                  {item.cron
                    ? `${txt(item.cron)} / ${txt(item.timezone)}`
                    : item.intervalSeconds || item.interval_seconds
                      ? `Every ${Number(item.intervalSeconds ?? item.interval_seconds) / 60} minutes`
                      : "One time"}
                </span>
                <span>
                  Next: {time(item.nextRunAt ?? item.runAt ?? item.next_run_at)}
                </span>
              </div>
            </div>
            <Button
              label="Remove"
              variant="ghost"
              isDisabled={action.busy}
              onClick={() =>
                void action.run(() =>
                  api(
                    `/schedules/${encodeURIComponent(txt(item.id))}`,
                    undefined,
                    "DELETE",
                  ),
                )
              }
            />
          </article>
        ))}
      </section>
    </>
  );
}
