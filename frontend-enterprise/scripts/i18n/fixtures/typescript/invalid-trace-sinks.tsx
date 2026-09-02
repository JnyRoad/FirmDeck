type StreamItem = {
  data: {
    message: string;
    text: string;
    status_text: string;
  };
};

type TraceLineRead = {
  text: string;
  detail?: string | null;
  outputTitle?: string | null;
};

type StreamState = {
  phase: string;
};

declare function upsertVisibleTraceLine(line: Record<string, unknown>): void;

/** Models backend event fields entering product trace chrome without a semantic mapping. */
export function InvalidTraceSinks({ item, line }: { item: StreamItem; line: TraceLineRead }) {
  const aliasedMessage = item.data.message;
  const stream: StreamState = { phase: '' };
  stream.phase = item.data.message;

  upsertVisibleTraceLine({
    text: item.data.message,
    detail: item.data.status_text,
    outputTitle: item.data.text,
  });
  upsertVisibleTraceLine({ text: aliasedMessage });

  return (
    <div>
      <span>{line.text}</span>
      <span>{line.detail}</span>
      <span>{line.outputTitle}</span>
    </div>
  );
}
