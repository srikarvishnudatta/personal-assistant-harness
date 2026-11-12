export function ErrorNotice({ value }: { value: string }) {
  return value ? (
    <p className="task-error" role="alert">
      {value}
    </p>
  ) : null;
}
