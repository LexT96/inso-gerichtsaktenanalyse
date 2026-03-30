interface ErrorDisplayProps {
  message: string;
}

export function ErrorDisplay({ message }: ErrorDisplayProps) {
  return (
    <div className="mt-3 p-2.5 px-3.5 bg-ie-red-bg border border-ie-red-border rounded-md text-ie-red text-[11px]">
      {message}
    </div>
  );
}
