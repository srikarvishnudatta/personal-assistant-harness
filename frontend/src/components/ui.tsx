import type { ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { txt } from "../lib/format";
export function Empty({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-symbol" aria-hidden="true">
        &#10035;
      </span>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
export function Card({
  title,
  children,
  actions,
}: {
  title: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="section-card">
      <div className="section-heading">
        <h2>{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}
export function Status({ value }: { value: unknown }) {
  return (
    <span className={`pill status-${txt(value)}`}>
      {(txt(value) || "unknown").replaceAll("_", " ")}
    </span>
  );
}
export function Feedback({
  loading,
  error,
  notice,
}: {
  loading?: boolean;
  error?: string;
  notice?: string;
}) {
  return (
    <>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="info-banner" role="status">
          {notice}
        </div>
      )}
      {loading && (
        <div className="loading" role="status">
          Loading...
        </div>
      )}
    </>
  );
}
export function Area({
  label,
  value,
  onChange,
  rows = 4,
  maxLength = 12000,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  maxLength?: number;
}) {
  return (
    <label className="native-field">
      {label}
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={rows}
        maxLength={maxLength}
      />
    </label>
  );
}
export function Refresh({
  reload,
  disabled,
}: {
  reload: () => Promise<void>;
  disabled?: boolean;
}) {
  return (
    <Button
      label="Refresh"
      variant="secondary"
      isDisabled={disabled}
      onClick={() => void reload()}
    />
  );
}
