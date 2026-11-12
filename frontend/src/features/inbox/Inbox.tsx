import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { type Api } from "../../api/client";
import { txt, list, time } from "../../lib/format";
import { session, setSession } from "../../lib/session";
import { useResource } from "../../hooks/useResource";
import { useAction } from "../../hooks/useAction";
import { Empty, Card, Feedback } from "../../components/ui";
import { type View } from "../../app/navigation";

export function Inbox({
  api,
  navigate,
}: {
  api: Api;
  navigate: (view: View) => void;
}) {
  const resource = useResource(api, "/notifications", true);
  const action = useAction(resource.reload);
  const [enabled, setEnabled] = useState(
    () =>
      session("harness-notifications") === "yes" &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted",
  );
  const seen = useRef<Set<string> | null>(null);
  const items = list(resource.data, "notifications");
  useEffect(() => {
    if (resource.loading) return;
    if (
      enabled &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted" &&
      seen.current
    )
      for (const item of items)
        if (!seen.current.has(txt(item.id)) && !item.readAt && !item.read)
          new Notification(txt(item.title) || "Personal Harness", {
            body: txt(item.body ?? item.message).slice(0, 240),
          });
    seen.current = new Set(items.map((item) => txt(item.id)));
  }, [resource.data, resource.loading, enabled]);
  const enable = () =>
    void action.run(async () => {
      if (typeof Notification === "undefined")
        throw new Error(
          "Desktop notifications are not supported in this browser.",
        );
      const permission = await Notification.requestPermission();
      if (permission !== "granted")
        throw new Error(
          "Permission was not granted. Results remain available in Inbox.",
        );
      setSession("harness-notifications", "yes");
      setEnabled(true);
    });
  return (
    <>
      <Feedback
        loading={resource.loading}
        error={resource.error || action.error}
      />
      <Card
        title="Your attention, when it matters"
        actions={
          <Button
            label={
              enabled ? "Desktop notices enabled" : "Enable desktop notices"
            }
            variant="secondary"
            isDisabled={enabled || action.busy}
            onClick={enable}
          />
        }
      >
        <p className="section-description">
          Results persist in this inbox. Desktop notices run while Inbox is
          open; they are not push delivery after closing the app.
        </p>
      </Card>
      <section className="record-list">
        {!items.length && !resource.loading && (
          <Empty title="You're all caught up.">
            Meaningful results and requests will appear here.
          </Empty>
        )}
        {items.map((item) => (
          <article
            className={`record ${item.readAt || item.read ? "" : "unread-record"}`}
            key={txt(item.id)}
          >
            <div className="record-body">
              <div className="task-heading">
                <h3>{txt(item.title) || "Update"}</h3>
                <span className="record-meta">
                  {time(item.createdAt ?? item.created_at)}
                </span>
              </div>
              <p>{txt(item.body ?? item.message)}</p>
              {Boolean(item.taskId) && (
                <Button
                  label="View tasks"
                  variant="ghost"
                  onClick={() => navigate("Tasks")}
                />
              )}
            </div>
            {!item.readAt && !item.read && (
              <Button
                label="Mark read"
                variant="secondary"
                isDisabled={action.busy}
                onClick={() =>
                  void action.run(() =>
                    api(
                      `/notifications/${encodeURIComponent(txt(item.id))}/read`,
                      {},
                    ),
                  )
                }
              />
            )}
          </article>
        ))}
      </section>
    </>
  );
}
