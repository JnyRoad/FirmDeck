import type { ComponentType, ReactNode, SVGProps } from 'react';

import CodeBlock from '@/components/CodeBlock';
import StaffdeckIcon from '@/components/StaffdeckIcon';
import IconCotAdvance from '@/assets/staffdeck/cot-icons/advance.svg?react';
import IconCotExecute from '@/assets/staffdeck/cot-icons/execute.svg?react';
import IconCotGenerated from '@/assets/staffdeck/cot-icons/generated.svg?react';
import IconCotJudge from '@/assets/staffdeck/cot-icons/judge.svg?react';
import IconCotLoading from '@/assets/staffdeck/cot-icons/loading.svg?react';
import IconCotSelect from '@/assets/staffdeck/cot-icons/select.svg?react';
import IconCotTool from '@/assets/staffdeck/cot-icons/tool.svg?react';
import { RawContent } from '@/i18n/RawContent';
import type { MessageId } from '@/i18n/types';
import { useAppIntl } from '@/i18n/useAppIntl';
import { cn } from '@/lib/utils';

import {
  CHAT_TRACE_CHEVRON_CLASS,
  CHAT_TRACE_CHEVRON_EXPANDED_CLASS,
  CHAT_TRACE_CODE_BLOCK_CLASS,
  CHAT_TRACE_CODE_DETAILS_CLASS,
  CHAT_TRACE_CODE_SUMMARY_CLASS,
  CHAT_TRACE_DETAILS_CLASS,
  CHAT_TRACE_FLOW_TEXT_CLASS,
  CHAT_TRACE_ICON_CLASS,
  CHAT_TRACE_LINE_CLASS,
  CHAT_TRACE_LINE_CONTENT_CLASS,
  CHAT_TRACE_LINE_DETAIL_CLASS,
  CHAT_TRACE_LINE_TEXT_CLASS,
  CHAT_TRACE_LINE_TEXT_FAILED_CLASS,
  CHAT_TRACE_SUMMARY_CLASS,
  CHAT_TRACE_SUMMARY_FAILED_CLASS,
  CHAT_TRACE_SUMMARY_RUNNING_CLASS,
  CHAT_TRACE_WRAP_CLASS,
} from '../chatPageStyles';
import { traceLineIconName, traceSummaryIconName } from '../chatHelpers';
import type { CotTraceIconName, TraceLine } from '../chatTypes';
import MCPAppView from './MCPAppView';

const COT_ICON_MAP: Record<CotTraceIconName, ComponentType<SVGProps<SVGSVGElement>>> = {
  advance: IconCotAdvance,
  execute: IconCotExecute,
  generated: IconCotGenerated,
  judge: IconCotJudge,
  loading: IconCotLoading,
  select: IconCotSelect,
  tool: IconCotTool,
};

const TRACE_CHROME_IDS: Readonly<Record<string, MessageId>> = {
  'chat.trace.executingTool': 'chat.trace.executingTool',
  'chat.trace.viewCode': 'chat.trace.viewCode',
  'chat.trace.viewOutput': 'chat.trace.viewOutput',
  '正在执行工具': 'chat.trace.executingTool',
  '查看代码': 'chat.trace.viewCode',
  '查看输出': 'chat.trace.viewOutput',
};

/** 只把已登记的系统 trace 文案映射到语义 ID，未知值一律视为 raw 诊断或业务内容。 */
function traceChromeText(value: string, translate: (id: MessageId) => string): ReactNode {
  const messageId = TRACE_CHROME_IDS[value];
  return messageId ? translate(messageId) : <RawContent value={value} />;
}

function CotTraceIcon({ name }: { name: CotTraceIconName }) {
  const Icon = COT_ICON_MAP[name];
  return (
    <span className={CHAT_TRACE_ICON_CLASS} aria-hidden="true">
      <Icon />
    </span>
  );
}

type ExecutionRecordProps = {
  traceTurnId: string;
  summary: { text: string; state: TraceLine['state'] };
  details: TraceLine[];
  expanded: boolean;
  onToggle: (turnId: string, isExpanded: boolean) => void;
};

export default function ExecutionRecord({
  traceTurnId,
  summary,
  details,
  expanded,
  onToggle,
}: ExecutionRecordProps) {
  const { t } = useAppIntl();

  return (
    <div className={CHAT_TRACE_WRAP_CLASS}>
      <button
        type="button"
        className={cn(
          CHAT_TRACE_SUMMARY_CLASS,
          summary.state === 'running' && CHAT_TRACE_SUMMARY_RUNNING_CLASS,
          summary.state === 'failed' && CHAT_TRACE_SUMMARY_FAILED_CLASS,
        )}
        onClick={() => onToggle(traceTurnId, expanded)}
      >
        <CotTraceIcon name={traceSummaryIconName(summary)} />
        <span className={cn(summary.state === 'running' && CHAT_TRACE_FLOW_TEXT_CLASS)}>
          {traceChromeText(summary.text, t)}
        </span>
        {details.length > 0 && (
          <StaffdeckIcon
            name="arrow"
            size={14}
            className={cn(CHAT_TRACE_CHEVRON_CLASS, expanded && CHAT_TRACE_CHEVRON_EXPANDED_CLASS)}
          />
        )}
      </button>
      {expanded && details.length > 0 && (
        <div className={CHAT_TRACE_DETAILS_CLASS}>
          {details.map((line) => (
            <div
              key={line.id}
              className={CHAT_TRACE_LINE_CLASS}
              style={line.depth ? { marginLeft: `${Math.min(line.depth, 3) * 20}px` } : undefined}
            >
              <CotTraceIcon name={traceLineIconName(line)} />
              <span className={CHAT_TRACE_LINE_CONTENT_CLASS}>
                <span
                  className={cn(
                    CHAT_TRACE_LINE_TEXT_CLASS,
                    line.state === 'running' && CHAT_TRACE_FLOW_TEXT_CLASS,
                    line.state === 'failed' && CHAT_TRACE_LINE_TEXT_FAILED_CLASS,
                  )}
                >
                  {traceChromeText(line.text, t)}
                </span>
                {line.detail && (
                  <span className={CHAT_TRACE_LINE_DETAIL_CLASS}>
                    {traceChromeText(line.detail, t)}
                  </span>
                )}
                {line.code && (
                  <details className={CHAT_TRACE_CODE_DETAILS_CLASS}>
                    <summary className={CHAT_TRACE_CODE_SUMMARY_CLASS}>
                      {t('chat.trace.viewCode')}
                    </summary>
                    <CodeBlock className={CHAT_TRACE_CODE_BLOCK_CLASS} code={line.code} language={line.language || 'python'} />
                  </details>
                )}
                {line.output && (
                  <details className={CHAT_TRACE_CODE_DETAILS_CLASS}>
                    <summary className={CHAT_TRACE_CODE_SUMMARY_CLASS}>
                      {line.outputTitle
                        ? traceChromeText(line.outputTitle, t)
                        : t('chat.trace.viewOutput')}
                    </summary>
                    <CodeBlock className={CHAT_TRACE_CODE_BLOCK_CLASS} code={line.output} language={line.outputLanguage || 'text'} />
                  </details>
                )}
                {line.mcpApp && <MCPAppView descriptor={line.mcpApp} />}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
