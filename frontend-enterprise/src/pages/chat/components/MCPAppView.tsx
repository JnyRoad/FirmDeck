import { useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/api/client';
import StaffdeckIcon from '@/components/StaffdeckIcon';
import { useAppIntl } from '@/i18n/useAppIntl';

import type { MCPAppViewDescriptor } from '../chatTypes';

const APP_PROTOCOL_VERSION = '2026-01-26';

type AppResource = {
  server_id: string;
  uri: string;
  mime_type: string;
  text: string;
  meta: {
    ui?: {
      csp?: Record<string, string[]>;
      permissions?: string[];
    };
  };
};

type AppCallResponse = {
  success: boolean;
  result?: unknown;
  requires_confirmation?: boolean;
  error?: { code?: string; message?: string } | null;
};

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
};

type AppMessage = JsonRpcRequest & {
  method?: string;
};

/** 渲染 MCP 宿主边界：产品 chrome 使用语义消息，第三方资源和协议 payload 保持原样。 */
export default function MCPAppView({ descriptor }: { descriptor: MCPAppViewDescriptor }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [resource, setResource] = useState<AppResource | null>(null);
  const [resourceLoadFailed, setResourceLoadFailed] = useState(false);
  const { t } = useAppIntl();

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({
      tenant_id: descriptor.tenant_id || '',
      uri: descriptor.resource_uri,
    });
    if (descriptor.agent_id) query.set('agent_id', descriptor.agent_id);
    api
      .get<AppResource>(`/api/enterprise/mcp-servers/${descriptor.server_id}/app-resource?${query}`)
      .then((next) => {
        if (active) {
          setResource(next);
          setResourceLoadFailed(false);
        }
      })
      .catch((reason) => {
        if (!active) return;
        // 原始 provider/网络异常只进入诊断日志，不把技术详情暴露给第三方 iframe 或产品 UI。
        console.error('[mcp-app] resource load failed', reason);
        setResourceLoadFailed(true);
      });
    return () => {
      active = false;
    };
  }, [descriptor.agent_id, descriptor.resource_uri, descriptor.server_id, descriptor.tenant_id]);

  const srcDoc = useMemo(
    () => resource ? injectContentSecurityPolicy(resource.text, resource.meta.ui?.csp || {}) : '',
    [resource],
  );

  useEffect(() => {
    if (!resource) return undefined;
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== iframeRef.current?.contentWindow || !isAppMessage(event.data)) return;
      const request = event.data;
      if (request.method === 'ui/initialize' || request.method === 'ui/initialize/request') {
        postRpcResult(request.id, {
          protocolVersion: APP_PROTOCOL_VERSION,
          hostInfo: { name: 'StaffDeck', version: '1' },
          hostCapabilities: { tools: { call: true }, textFallback: true },
        });
        return;
      }
      if (request.method === 'tools/call' || request.method === 'ui/tools/call') {
        void callTool(request);
      }
    };

    const callTool = async (request: JsonRpcRequest) => {
      const params = request.params || {};
      const toolName = typeof params.name === 'string' ? params.name : descriptor.tool_name;
      const argumentsValue = isRecord(params.arguments) ? params.arguments : {};
      const payload = {
        tenant_id: descriptor.tenant_id || '',
        tool_name: toolName,
        arguments: argumentsValue,
        agent_id: descriptor.agent_id || null,
        session_id: descriptor.session_id || null,
        active_skill_id: descriptor.active_skill_id || null,
        confirm_side_effect: false,
      };
      try {
        let response = await api.post<AppCallResponse>(
          `/api/enterprise/mcp-servers/${descriptor.server_id}/app-call`,
          payload,
        );
        if (response.requires_confirmation) {
          const confirmed = window.confirm(t('chat.mcp.confirmSideEffect', { toolName }));
          if (!confirmed) {
            postRpcError(request.id, -32001, t('chat.mcp.userCancelled'));
            return;
          }
          response = await api.post<AppCallResponse>(
            `/api/enterprise/mcp-servers/${descriptor.server_id}/app-call`,
            { ...payload, confirm_side_effect: true },
          );
        }
        if (!response.success) {
          // provider message 属于技术诊断；只返回稳定 RPC code 对应的安全产品文案。
          console.error('[mcp-app] tool call failed', response.error);
          postRpcError(request.id, -32000, t('chat.mcp.toolCallFailed'));
          return;
        }
        postRpcResult(request.id, response.result ?? null);
      } catch (reason) {
        // 保留根因供宿主诊断，但禁止将异常消息作为最终用户文本或 iframe 协议消息。
        console.error('[mcp-app] tool call exception', reason);
        postRpcError(request.id, -32000, t('chat.mcp.toolCallFailed'));
      }
    };

    const postRpcResult = (id: JsonRpcRequest['id'], result: unknown) => {
      iframeRef.current?.contentWindow?.postMessage({ jsonrpc: '2.0', id, result }, '*');
    };
    const postRpcError = (id: JsonRpcRequest['id'], code: number, message: string) => {
      iframeRef.current?.contentWindow?.postMessage({ jsonrpc: '2.0', id, error: { code, message } }, '*');
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [descriptor, resource, t]);

  const notifyInitialResult = () => {
    const params = {
      content: descriptor.initial_result,
      _meta: descriptor.initial_meta || {},
    };
    for (const method of ['ui/notifications/tool-result', 'ui/notifications/tool-result-ready']) {
      iframeRef.current?.contentWindow?.postMessage({ jsonrpc: '2.0', method, params }, '*');
    }
  };

  if (resourceLoadFailed) {
    return (
      <div className="mt-2 flex items-start gap-2 rounded-lg border border-[#eceef1] bg-[#fafbfc] px-3 py-2 text-xs text-[#858b9c]">
        <StaffdeckIcon name="warning" size={14} />
        <span>{t('chat.mcp.renderFailed')}</span>
      </div>
    );
  }
  if (!resource) {
    return (
      <div
        className="mt-2 text-xs text-[#858b9c]"
        role="status"
        aria-label={t('chat.mcp.loading')}
      >
        {t('chat.mcp.loading')}
      </div>
    );
  }
  return (
    <section
      className="mt-2 overflow-hidden rounded-xl border border-[#dfe5e2] bg-white"
      aria-label={t('chat.mcp.appLabel')}
    >
      <div className="flex items-center justify-between border-b border-[#eceef1] bg-[#fafbfc] px-3 py-2 text-xs text-[#5f6675]">
        <span className="font-medium">{t('chat.mcp.header', { toolName: descriptor.tool_name })}</span>
        <span>{t('chat.mcp.isolatedView')}</span>
      </div>
      <iframe
        ref={iframeRef}
        title={t('chat.mcp.iframeTitle', { toolName: descriptor.tool_name })}
        className="h-[360px] w-full border-0 bg-white"
        sandbox="allow-scripts"
        allow={(resource.meta.ui?.permissions || []).join('; ')}
        srcDoc={srcDoc}
        onLoad={notifyInitialResult}
      />
    </section>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isAppMessage(value: unknown): value is AppMessage {
  return isRecord(value) && typeof value.method === 'string';
}

function injectContentSecurityPolicy(html: string, csp: Record<string, string[]>): string {
  const resourceDomains = csp.resourceDomains || [];
  const connectDomains = csp.connectDomains || [];
  const frameDomains = csp.frameDomains || [];
  const policy = [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${resourceDomains.join(' ')}`.trim(),
    `style-src 'unsafe-inline' ${resourceDomains.join(' ')}`.trim(),
    `img-src data: blob: ${resourceDomains.join(' ')}`.trim(),
    `font-src ${resourceDomains.join(' ')}`.trim(),
    `connect-src ${connectDomains.join(' ')}`.trim(),
    `frame-src ${frameDomains.join(' ')}`.trim(),
  ].join('; ');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttribute(policy)}">`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${meta}`);
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
