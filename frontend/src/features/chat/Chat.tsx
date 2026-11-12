import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { type Api } from "../../api/client";
import { txt, list } from "../../lib/format";
import { useResource } from "../../hooks/useResource";
import { useAction } from "../../hooks/useAction";
import { Empty, Feedback } from "../../components/ui";

export function Chat({ api, model }: { api: Api; model: string }) {
  const resource = useResource(api, "/history");
  const action = useAction(resource.reload);
  const [input, setInput] = useState("");
  const end = useRef<HTMLDivElement>(null);
  const messages = list(resource.data, "messages");
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages.length, action.busy]);
  const send = () => {
    if (input.trim())
      void action.run(async () => {
        await api("/chat", { message: input.trim() });
        setInput("");
      });
  };
  return (
    <>
      <Feedback
        loading={resource.loading}
        error={resource.error || action.error}
      />
      <section className="chat-panel">
        <div
          className="conversation"
          role="log"
          aria-label="Conversation"
          aria-live="polite"
        >
          {!messages.length && !resource.loading ? (
            <>
              <Empty title="Start with anything.">
                An idea to explore. A task to untangle.
              </Empty>
              <div className="prompt-grid">
                {[
                  "Help me plan my week",
                  "What do you remember about me?",
                  "Help me break down a goal",
                ].map((prompt) => (
                  <button
                    key={prompt}
                    className="prompt-card"
                    onClick={() => setInput(prompt)}
                  >
                    {prompt}
                    <span>&rarr;</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            messages.map((message, index) => (
              <article
                className={`message ${message.role === "user" ? "user-message" : "assistant-message"}`}
                key={txt(message.id) || index}
              >
                <span className="message-avatar">
                  {message.role === "user" ? "Y" : "A"}
                </span>
                <div>
                  <div className="message-author">
                    {message.role === "user" ? "You" : "Assistant"}
                  </div>
                  <p>{txt(message.content ?? message.text)}</p>
                </div>
              </article>
            ))
          )}
          {action.busy && (
            <div className="thinking" role="status">
              Thinking through it.
            </div>
          )}
          <div ref={end} />
        </div>
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            send();
          }}
        >
          <label htmlFor="message" className="visually-hidden">
            Message your assistant
          </label>
          <textarea
            id="message"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={action.busy}
            rows={2}
            maxLength={12000}
            placeholder="Tell me what you're working on."
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-footer">
            <span>Enter to send / Shift + Enter for a new line</span>
            <Button
              label={action.busy ? "Working" : "Send message"}
              variant="primary"
              isDisabled={action.busy || !input.trim()}
              onClick={send}
            />
          </div>
        </form>
        <div className="privacy-note">
          {model} / Review saved context in Memory.
        </div>
      </section>
    </>
  );
}
