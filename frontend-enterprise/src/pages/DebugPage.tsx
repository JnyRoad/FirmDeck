/** Agent 调试页：产品 chrome 由语义 i18n 投影，用户输入与执行诊断保持 raw。 */

import { SendOutlined } from '../icons';
import { useState } from 'react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
} from '@/components/ui';
import { createToastNotifier } from '@/components/ui/app-toast';
import { createMessageDescriptor, type MessageDescriptor } from '@/i18n/descriptors';
import { RawContent } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import type { MessageId } from '@/i18n/types';
import { backendErrorMessageDescriptor } from '@/lib/apiErrorMessages';
import { api, TENANT_ID } from '../api/client';
import type { ChatTurnResponse } from '../types';

type ChatMessage = { role: 'user' | 'assistant'; content: string };

const DEBUG_MESSAGE_IDS = {
  titleId: 'knowledgePage.cards.searchDebugTitle',
  sessionId: 'scheduledTasksPage.column.session',
  inputId: 'chat.composer.placeholder',
  sendId: 'common.action.send',
  snapshotId: 'chat.trace.executionRecord',
  routerId: 'chat.trace.router',
  stepId: 'chat.trace.nextStep',
  toolId: 'chat.trace.toolResult',
  sessionStateId: 'chat.dialog.contextSummary',
  replyFailedId: 'chat.error.replyFailed',
} as const satisfies Record<string, MessageId>;

/** 将后端错误收窄为稳定的 toast descriptor，未知异常只走安全的本地化 fallback。 */
function debugErrorDescriptor(error: unknown): MessageDescriptor {
  const descriptor = backendErrorMessageDescriptor(error);
  return descriptor
    ? { id: descriptor.messageId, values: descriptor.values }
    : createMessageDescriptor(DEBUG_MESSAGE_IDS.replyFailedId);
}

/** 将调试对象序列化为只读 raw 诊断文本；序列化失败时返回空值而不伪造产品文案。 */
function serializeDebugPayload(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return '';
  }
}

/** 渲染 Agent 调试页；副作用仅限提交调试请求与显示安全 toast。 */
export default function DebugPage() {
  const { t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const [sessionId, setSessionId] = useState('');
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [lastTurn, setLastTurn] = useState<ChatTurnResponse | null>(null);
  const [loading, setLoading] = useState(false);

  /** 提交调试消息并保存服务端返回的会话、回复和 raw 诊断快照。 */
  async function send() {
    if (!input.trim()) return;
    const userText = input;
    setInput('');
    setMessages((items) => [...items, { role: 'user', content: userText }]);
    setLoading(true);
    try {
      const result = await api.post<ChatTurnResponse>('/api/chat/turn', {
        tenant_id: TENANT_ID,
        session_id: sessionId || undefined,
        user_id: 'enterprise_debugger',
        message: userText,
        channel: 'enterprise_debug',
        debug: true,
      });
      setSessionId(result.session_id);
      setLastTurn(result);
      setMessages((items) => [...items, { role: 'assistant', content: result.reply }]);
    } catch (error) {
      console.error('[debug-page] turn failed', error);
      toast.error(debugErrorDescriptor(error));
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div className="page-title">
        <h3>{t(DEBUG_MESSAGE_IDS.titleId)}</h3>
        <Input
          className="page-field w-[240px]"
          value={sessionId}
          onChange={(event) => setSessionId(event.target.value)}
          placeholder={t(DEBUG_MESSAGE_IDS.sessionId)}
        />
      </div>
      <div className="grid-2">
        <Card>
          <CardContent>
            <div className="chat-panel">
              <div className="messages">
                {messages.map((item, index) => (
                  <div key={`${item.role}-${index}`} className={`message-row ${item.role}`}>
                    <div className="bubble"><RawContent value={item.content} /></div>
                  </div>
                ))}
              </div>
              <div className="flex gap-[8px]">
                <Input
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={t(DEBUG_MESSAGE_IDS.inputId)}
                />
                <Button disabled={loading} onClick={() => void send()}>
                  <SendOutlined />
                  {t(DEBUG_MESSAGE_IDS.sendId)}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t(DEBUG_MESSAGE_IDS.snapshotId)}</CardTitle>
          </CardHeader>
          <CardContent>
            <Accordion type="multiple" defaultValue={['router', 'session']}>
              <AccordionItem value="router">
                <AccordionTrigger>{t(DEBUG_MESSAGE_IDS.routerId)}</AccordionTrigger>
                <AccordionContent><pre><RawContent value={serializeDebugPayload(lastTurn?.router_decision)} /></pre></AccordionContent>
              </AccordionItem>
              <AccordionItem value="step">
                <AccordionTrigger>{t(DEBUG_MESSAGE_IDS.stepId)}</AccordionTrigger>
                <AccordionContent><pre><RawContent value={serializeDebugPayload(lastTurn?.step_result)} /></pre></AccordionContent>
              </AccordionItem>
              <AccordionItem value="tool">
                <AccordionTrigger>{t(DEBUG_MESSAGE_IDS.toolId)}</AccordionTrigger>
                <AccordionContent><pre><RawContent value={serializeDebugPayload(lastTurn?.tool_result)} /></pre></AccordionContent>
              </AccordionItem>
              <AccordionItem value="session">
                <AccordionTrigger>{t(DEBUG_MESSAGE_IDS.sessionStateId)}</AccordionTrigger>
                <AccordionContent><pre><RawContent value={serializeDebugPayload(lastTurn?.session_state)} /></pre></AccordionContent>
              </AccordionItem>
            </Accordion>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
