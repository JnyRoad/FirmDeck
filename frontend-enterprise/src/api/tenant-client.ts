import { ApiError, API_BASE } from './client';
import type { TenantSessionContextValue } from '../contexts/TenantSessionContext';

export type TenantClient = {
  get<T>(path: string, options?: RequestInit): Promise<T>;
  post<T>(path: string, body?: unknown, options?: RequestInit): Promise<T>;
  postWithSignal<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T>;
  put<T>(path: string, body: unknown, options?: RequestInit): Promise<T>;
  delete<T>(path: string, body?: unknown, options?: RequestInit): Promise<T>;
  blob(path: string, options?: RequestInit): Promise<Blob>;
  postBlob(path: string, body: unknown, options?: RequestInit): Promise<Blob>;
};

class TenantClientError extends Error {
  constructor(message = '租户请求上下文不可用') {
    super(message);
    this.name = 'TenantClientError';
  }
}

type CombinedSignal = {
  signal: AbortSignal | undefined;
  cleanup: () => void;
};

function combineSignals(
  scopeSignal: AbortSignal,
  requestSignal?: AbortSignal,
): CombinedSignal {
  if (!requestSignal) return { signal: scopeSignal, cleanup: () => {} };
  if (scopeSignal === requestSignal) return { signal: scopeSignal, cleanup: () => {} };

  const controller = new AbortController();
  const abort = () => controller.abort();
  if (scopeSignal.aborted || requestSignal.aborted) {
    controller.abort();
    return { signal: controller.signal, cleanup: () => {} };
  }

  scopeSignal.addEventListener('abort', abort, { once: true });
  requestSignal.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      scopeSignal.removeEventListener('abort', abort);
      requestSignal.removeEventListener('abort', abort);
    },
  };
}

function requestUrl(path: string): URL {
  const raw = /^(?:https?:|blob:)/i.test(path) ? path : `${API_BASE}${path}`;
  return new URL(raw, window.location.origin);
}

function withTenantQuery(path: string, tenantId: string): string {
  const url = requestUrl(path);
  const existingTenantIds = url.searchParams.getAll('tenant_id');
  if (existingTenantIds.some((value) => value !== tenantId)) {
    throw new TenantClientError('租户请求上下文不匹配');
  }
  url.searchParams.set('tenant_id', tenantId);

  // Preserve the relative URL shape used by the Vite proxy when no explicit
  // API base is configured; configured deployments retain their absolute URL.
  if (!API_BASE && !/^(?:https?:|blob:)/i.test(path)) {
    return `${url.pathname}${url.search}${url.hash}`;
  }
  return url.toString();
}

function jsonTenantBody(body: unknown, tenantId: string): string {
  if (body === undefined) return JSON.stringify({ tenant_id: tenantId });
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TenantClientError('租户请求体格式无效');
  }

  const record = body as Record<string, unknown>;
  if (record.tenant_id !== undefined && record.tenant_id !== tenantId) {
    throw new TenantClientError('租户请求上下文不匹配');
  }
  return JSON.stringify({ ...record, tenant_id: tenantId });
}

function formTenantBody(body: FormData, tenantId: string): FormData {
  const copy = new FormData();
  body.forEach((value, key) => copy.append(key, value));
  const existing = copy.getAll('tenant_id');
  if (existing.some((value) => value !== tenantId)) {
    throw new TenantClientError('租户请求上下文不匹配');
  }
  if (existing.length === 0) copy.append('tenant_id', tenantId);
  return copy;
}

function responseIsCurrent(
  context: TenantSessionContextValue,
  generation: number,
  signal: AbortSignal,
): boolean {
  return !signal.aborted
    && !context.signal.aborted
    && context.isCurrentGeneration(generation);
}

async function readJsonResponse<T>(
  response: Response,
  context: TenantSessionContextValue,
  generation: number,
  signal: AbortSignal,
): Promise<T> {
  if (!responseIsCurrent(context, generation, signal)) throw new TenantClientError();
  if (!response.ok) {
    const text = await response.text();
    if (!responseIsCurrent(context, generation, signal)) throw new TenantClientError();
    throw new ApiError(response.status, text, response.statusText);
  }
  const text = await response.text();
  if (!responseIsCurrent(context, generation, signal)) throw new TenantClientError();
  return (text ? JSON.parse(text) : {}) as T;
}

async function readBlobResponse(
  response: Response,
  context: TenantSessionContextValue,
  generation: number,
  signal: AbortSignal,
): Promise<Blob> {
  if (!responseIsCurrent(context, generation, signal)) throw new TenantClientError();
  if (!response.ok) {
    const text = await response.text();
    if (!responseIsCurrent(context, generation, signal)) throw new TenantClientError();
    throw new ApiError(response.status, text, response.statusText);
  }
  const blob = await response.blob();
  if (!responseIsCurrent(context, generation, signal)) throw new TenantClientError();
  return blob;
}

function createRequestHeaders(options: RequestInit, hasJsonBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  const supplied = options.headers;
  if (supplied instanceof Headers) {
    supplied.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (Array.isArray(supplied)) {
    supplied.forEach(([key, value]) => {
      headers[key] = value;
    });
  } else if (supplied) {
    Object.entries(supplied).forEach(([key, value]) => {
      if (typeof value === 'string') headers[key] = value;
    });
  }
  delete headers['Content-Type'];
  if (hasJsonBody) headers['Content-Type'] = 'application/json';
  // Keep these exact keys authoritative even if a caller supplied another
  // casing or attempted to override the verified bearer.
  Object.keys(headers).forEach((key) => {
    if (key.toLowerCase() === 'authorization') delete headers[key];
    if (key.toLowerCase() === 'content-type' && key !== 'Content-Type') delete headers[key];
  });
  return headers;
}

export function createTenantClient(context: TenantSessionContextValue | null): TenantClient {
  const request = async <T>(
    method: string,
    path: string,
    body?: unknown,
    options: RequestInit = {},
    responseType: 'json' | 'blob' = 'json',
  ): Promise<T> => {
    if (!context) throw new TenantClientError();
    const generation = context.generation;
    const tenantId = context.tenantId;
    const requestSignal = options.signal ?? undefined;
    const combined = combineSignals(context.signal, requestSignal);
    const signal = combined.signal || context.signal;

    try {
      if (!responseIsCurrent(context, generation, signal)) throw new TenantClientError();

      const isFormData = body instanceof FormData;
      const hasBody = body !== undefined;
      let requestBody: BodyInit | undefined;
      if (hasBody && isFormData) {
        requestBody = formTenantBody(body as FormData, tenantId);
      } else if (hasBody || method !== 'GET') {
        requestBody = jsonTenantBody(body, tenantId);
      }

      const url = withTenantQuery(path, tenantId);
      const headers = createRequestHeaders(options, !isFormData && requestBody !== undefined);
      headers.Authorization = `Bearer ${context.session.token}`;

      const response = await fetch(url, {
        ...options,
        method,
        credentials: 'include',
        headers,
        body: requestBody,
        signal,
      });
      if (responseType === 'blob') {
        return await readBlobResponse(response, context, generation, signal) as T;
      }
      return await readJsonResponse(response, context, generation, signal);
    } finally {
      combined.cleanup();
    }
  };

  return {
    get: <T>(path: string, options?: RequestInit) => request<T>('GET', path, undefined, options),
    post: <T>(path: string, body?: unknown, options?: RequestInit) => (
      request<T>('POST', path, body, options)
    ),
    postWithSignal: <T>(path: string, body: unknown, signal?: AbortSignal) => (
      request<T>('POST', path, body, { signal })
    ),
    put: <T>(path: string, body: unknown, options?: RequestInit) => (
      request<T>('PUT', path, body, options)
    ),
    delete: <T>(path: string, body?: unknown, options?: RequestInit) => (
      request<T>('DELETE', path, body, options)
    ),
    blob: (path: string, options?: RequestInit) => (
      request<Blob>('GET', path, undefined, options, 'blob')
    ),
    postBlob: (path: string, body: unknown, options?: RequestInit) => (
      request<Blob>('POST', path, body, options, 'blob')
    ),
  };
}
