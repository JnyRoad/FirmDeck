type StreamItem = {
  data: {
    code: string;
    params: Record<string, unknown>;
    stdout: string;
    stderr: string;
    output: string;
  };
};

type TraceLineRead = {
  text: string;
  detail?: string | null;
  output?: string | null;
};

type StreamState = {
  phase: string;
};

type ToolResult = {
  detail: string;
};

type UserMessage = {
  message: string;
};

type AgentReply = {
  text: string;
};

type KnowledgeDocument = {
  text: string;
};

declare function upsertVisibleTraceLine(line: Record<string, unknown>): void;
declare function backendEventMessage(code: string, params: Record<string, unknown>): string;
declare function t(id: 'fixture.trace.message'): string;
declare function RawContent(props: { children: unknown }): unknown;
declare function traceChromeText(value: string, translate: unknown): unknown;
declare function generalSkillTraceOutput(
  item: StreamItem,
  detail: string,
): { output?: string; title?: string };

/** Keeps translated product chrome and explicitly raw payloads outside the trace sink finding. */
export function ValidTraceSinks({
  item,
  line,
  tool,
  userMessage,
  agentReply,
  document,
}: {
  item: StreamItem;
  line: TraceLineRead;
  tool: ToolResult;
  userMessage: UserMessage;
  agentReply: AgentReply;
  document: KnowledgeDocument;
}) {
  upsertVisibleTraceLine({
    text: t('fixture.trace.message'),
    detail: backendEventMessage(item.data.code, item.data.params),
  });
  upsertVisibleTraceLine({ detail: tool.detail });
  const stream: StreamState = { phase: '' };
  stream.phase = backendEventMessage(item.data.code, item.data.params);

  const existing: TraceLineRead | null = null;
  const previousOutput = existing?.output || existing?.detail || '';
  const rawDetail = item.data.stdout;
  const detail = rawDetail ? `${previousOutput}${rawDetail}` : rawDetail;
  const outputInfo = generalSkillTraceOutput(item, detail);
  upsertVisibleTraceLine({
    detail: outputInfo.output ? undefined : detail,
  });

  return (
    <>
      <RawContent>{line.text}</RawContent>
      <span>{traceChromeText(line.text, t)}</span>
      <span>{userMessage.message}</span>
      <span>{agentReply.text}</span>
      <span>{document.text}</span>
      <pre>{item.data.stdout}</pre>
      <code>{item.data.stderr}</code>
      <span>{item.data.code}</span>
      <span>{item.data.output}</span>
    </>
  );
}
