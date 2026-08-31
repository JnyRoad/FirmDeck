import { getEnterpriseAuthSession } from '../auth';

const resolveApiBase = () => {
  if (import.meta.env.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL;
  }

  return '';
};

const API_BASE = resolveApiBase();

export const TENANT_ID = import.meta.env.VITE_TENANT_ID || 'tenant_demo';
export const SHOW_DEBUG = import.meta.env.VITE_SHOW_DEBUG === 'true';

export class ApiError extends Error {
  status: number;
  body: string;
  code?: string;
  params: Record<string, unknown>;
  retryable?: boolean;
  request_id?: string;
  trace_id?: string;

  /** 解析机器可读错误描述并把原始响应仅保留在诊断 body，不将上游文本暴露为 Error.message。 */
  constructor(status: number, body: string, statusText: string) {
    const parsed = parseErrorPayload(body);
    super(GENERIC_ERROR_MESSAGE);
    this.name = 'ApiError';
    this.status = status;
    this.body = diagnosticResponseBody(body);
    this.code = parsed.code;
    this.params = parsed.params;
    this.retryable = parsed.retryable;
    this.request_id = parsed.request_id;
    this.trace_id = parsed.trace_id;
    void statusText;
  }
}

export function isAuthError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
      ...(options.headers || {}),
    },
    ...options,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new ApiError(response.status, text, response.statusText);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

async function keepalivePost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    keepalive: true,
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new ApiError(response.status, text, response.statusText);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

function authHeader(): Record<string, string> {
  const session = getEnterpriseAuthSession();
  return session?.token ? { Authorization: `Bearer ${session.token}` } : {};
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  postWithSignal: <T>(path: string, body: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body), signal }),
  postKeepalive: <T>(path: string, body?: unknown) => keepalivePost<T>(path, body),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(path: string, body?: unknown) => request<T>(path, {
    method: 'DELETE',
    body: body === undefined ? undefined : JSON.stringify(body),
  }),
  blob: async (path: string) => {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: {
        ...authHeader(),
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text, response.statusText);
    }
    return response.blob();
  },
  postBlob: async (path: string, body: unknown) => {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeader(),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new ApiError(response.status, text, response.statusText);
    }
    return response.blob();
  },
};

export async function uploadChatAttachments<T>(
  tenantId: string,
  files: File[],
  signal?: AbortSignal,
): Promise<T> {
  const form = new FormData();
  files.forEach((file) => form.append('files', file));
  const response = await fetch(`${API_BASE}/api/chat/attachments?tenant_id=${encodeURIComponent(tenantId)}`, {
    method: 'POST',
    headers: { ...authHeader() },
    body: form,
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new ApiError(response.status, text, response.statusText);
  }
  return response.json() as Promise<T>;
}

export async function streamChatTurn(
  body: Record<string, unknown>,
  onEvent: (item: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  return streamPost('/api/chat/stream', body, onEvent, signal);
}

export type StreamEvent = {
  event: string;
  data: Record<string, unknown>;
};

export async function streamPost(
  path: string,
  body: Record<string, unknown>,
  onEvent: (item: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new ApiError(response.status, text, response.statusText);
  }
  if (!response.body) {
    throw new Error('当前浏览器不支持流式响应');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    blocks.forEach((block) => {
      const parsed = parseSseBlock(block);
      if (parsed) onEvent(parsed);
    });
  }

  buffer += decoder.decode();
  const parsed = parseSseBlock(buffer);
  if (parsed) onEvent(parsed);
}

export async function streamGet(
  path: string,
  onEvent: (item: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_BASE}${path}`, { headers: { ...authHeader() }, signal });
  if (!response.ok) {
    const text = await response.text();
    throw new ApiError(response.status, text, response.statusText);
  }
  if (!response.body) {
    throw new Error('当前浏览器不支持流式响应');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() || '';
    blocks.forEach((block) => {
      const parsed = parseSseBlock(block);
      if (parsed) onEvent(parsed);
    });
  }

  buffer += decoder.decode();
  const parsed = parseSseBlock(buffer);
  if (parsed) onEvent(parsed);
}

function parseSseBlock(block: string): StreamEvent | null {
  const lines = block.split('\n').map((line) => line.trimEnd());
  const eventLine = lines.find((line) => line.startsWith('event:'));
  const dataLines = lines.filter((line) => line.startsWith('data:'));
  if (!eventLine || dataLines.length === 0) return null;
  const event = eventLine.replace(/^event:\s*/, '');
  const rawData = dataLines.map((line) => line.replace(/^data:\s*/, '')).join('\n');
  try {
    return { event, data: JSON.parse(rawData) as Record<string, unknown> };
  } catch {
    return { event, data: { raw: rawData } };
  }
}

type ParsedApiError = {
  code?: string;
  params: Record<string, unknown>;
  retryable?: boolean;
  request_id?: string;
  trace_id?: string;
};

const STABLE_ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]+$/;

const MAX_PLAUSIBLE_MESSAGE_LENGTH = 160;

export const GENERIC_ERROR_MESSAGE = '操作失败，请稍后重试。';

/**
 * Accepts arbitrary response text as a user-facing message only when it is
 * short enough to plausibly be a real error string. This is a length/shape
 * heuristic, not content sniffing — it lets us discard oversized bodies
 * (e.g. an intercepting proxy's HTML page) without special-casing any
 * particular gateway or content type.
 */
export function plausibleShortMessage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return Array.from(trimmed).length <= MAX_PLAUSIBLE_MESSAGE_LENGTH ? trimmed : null;
}

function stableErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && STABLE_ERROR_CODE_PATTERN.test(value)
    ? value
    : undefined;
}

/** 判断 JSON 值是否为普通键值对象，拒绝数组等不符合 canonical params 契约的形状。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** 读取有界关联 ID；非法值不影响错误 fail-closed，也不会拼入最终用户文案。 */
function correlationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 256 ? normalized : undefined;
}

/** 收集 JSON 诊断树中的原始字符串，使转义后的 stack/detail 仍可由受控诊断入口检索。 */
function collectDiagnosticStrings(value: unknown, output: string[], depth = 0): void {
  if (depth > 8) return;
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectDiagnosticStrings(item, output, depth + 1));
    return;
  }
  if (!isRecord(value)) return;
  Object.values(value).forEach((item) => collectDiagnosticStrings(item, output, depth + 1));
}

/** 保留原始响应，并附加已解码诊断字符串；该结果仅存于 ApiError.body，不进入 message/UI。 */
function diagnosticResponseBody(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    const strings: string[] = [];
    collectDiagnosticStrings(parsed, strings);
    return strings.length > 0 ? `${body}\n${strings.join('\n')}` : body;
  } catch {
    return body;
  }
}

/** 解析 canonical 或精确 legacy code 投影；任何自然语言字段只留在原始 body 中。 */
function parseErrorPayload(text: string): ParsedApiError {
  const empty: ParsedApiError = { params: {} };
  if (!text) return empty;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) return empty;

    const request_id = correlationId(parsed.request_id);
    const trace_id = correlationId(parsed.trace_id);
    const diagnostic = { params: {}, request_id, trace_id } satisfies ParsedApiError;
    const topLevelCode = stableErrorCode(parsed.code);
    if (parsed.code !== undefined) {
      if (!topLevelCode || !isRecord(parsed.params) || typeof parsed.retryable !== 'boolean') {
        return diagnostic;
      }
      return {
        code: topLevelCode,
        params: { ...parsed.params },
        retryable: parsed.retryable,
        request_id,
        trace_id,
      };
    }

    const detailCode = typeof parsed.detail === 'string'
      ? stableErrorCode(parsed.detail)
      : isRecord(parsed.detail)
        ? stableErrorCode(parsed.detail.code)
        : undefined;
    return detailCode ? { ...diagnostic, code: detailCode } : diagnostic;
  } catch {
    return empty;
  }
}
