import { type Api } from "../../api/client";
import { txt, pretty, list, time } from "../../lib/format";
import { useResource } from "../../hooks/useResource";
import { Empty, Card, Feedback, Refresh } from "../../components/ui";

export function Activity({ api }: { api: Api }) {
  const resource = useResource(api, "/events", true);
  const items = list(resource.data, "events");
  return (
    <>
      <Feedback loading={resource.loading} error={resource.error} />
      <Card title="Activity log" actions={<Refresh reload={resource.reload} />}>
        <p className="section-description">
          Recorded execution and decisions. A request or approval is not proof
          that an action completed.
        </p>
      </Card>
      <section className="record-list">
        {!items.length && !resource.loading && (
          <Empty title="Nothing recorded yet.">
            Execution and approval events appear here.
          </Empty>
        )}
        {items.map((item, index) => (
          <article className="record" key={txt(item.id) || index}>
            <div className="record-body">
              <div className="task-heading">
                <h3>{txt(item.type ?? item.kind)}</h3>
                <span className="record-meta">
                  {time(item.createdAt ?? item.created_at)}
                </span>
              </div>
              {Boolean(item.taskId ?? item.task_id) && (
                <div className="record-meta">
                  Task: {txt(item.taskId ?? item.task_id)}
                </div>
              )}
              <pre>{pretty(item.detail ?? item.data ?? item.payload)}</pre>
            </div>
          </article>
        ))}
      </section>
    </>
  );
}
