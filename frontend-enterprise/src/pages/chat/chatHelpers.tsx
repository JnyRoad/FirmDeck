import { useState, type ReactNode } from 'react';

import CodeBlock from '@/components/CodeBlock';
import { ApiError } from '@/api/client';
import type { StreamEvent } from '@/api/client';
import { createFormatters } from '@/i18n/formatters';
import type { MessageValues } from '@/i18n/imperative';
import type { AppLocale } from '@/i18n/locales';
import type { MessageId } from '@/i18n/types';
import { useAppIntl } from '@/i18n/useAppIntl';
import { tenantUserStorageKey } from '@/lib/tenant-storage';
import { getClientTimeZone, parseBackendDateTime } from '@/lib/timezone';
import type {
  ChatAttachmentRead,
  ChatMessage,
  ChatSession,
  ChatSessionEventRead,
  HarnessWorkspaceArtifact,
  KnowledgeCitation,
  ScheduledTaskDraftRead,
  ScheduledTaskRead,
  UIConfigRead,
} from '@/types';

import {
  CHAT_MARKDOWN_CLASS,
  CHAT_MARKDOWN_IMAGE_CLASS,
  CHAT_MARKDOWN_IMAGE_LINK_CLASS,
  CHAT_MD_TABLE_CLASS,
  CHAT_MD_TABLE_SCROLL_CLASS,
} from './chatPageStyles';
import type {
  ComposerAttachment,
  CotTraceIconName,
  DraftScheduleType,
  SessionSlot,
  TraceLine,
  TraceSkill,
  TraceTool,
  TurnTrace,
} from './chatTypes';
export { sessionFilterStorageKey } from '@/lib/agent-scope-storage';

export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'skill_agent_sidebar_collapsed';
export const RUNNING_EVENT_RECOVERY_WINDOW_MS = 600 * 1000;
export const CHAT_STREAM_IDLE_TIMEOUT_MS = 600 * 1000;
export const CHAT_STREAM_IDLE_CHECK_INTERVAL_MS = 5 * 1000;
export const CHAT_STREAM_HEARTBEAT_GRACE_MS = 20 * 1000;
export const CHAT_TRACE_RECOVERY_WINDOW_MS = 10 * 60 * 1000;
export const STREAM_TERMINAL_EVENTS = new Set(['complete', 'done', 'stream_end', 'stream_cancelled', 'stream_interrupted', 'error', 'error_occurred']);
export const HIDDEN_GENERAL_SKILL_TRACE_PHASES = new Set(['replying']);
/** 旧协议停止状态 marker；仅用于精确识别历史系统消息，不作为展示文案或翻译源。 */
export const LEGACY_STOPPED_GENERATION_MARKER = '已停止生成';
const DRAFT_SCHEDULE_TYPES = new Set<DraftScheduleType>(['once', 'daily', 'weekly', 'monthly']);

export type ChatTranslate = (id: MessageId, values?: MessageValues) => string;

const DRAFT_WEEKDAY_MESSAGE_IDS = [
  'chat.draft.weekday.monday',
  'chat.draft.weekday.tuesday',
  'chat.draft.weekday.wednesday',
  'chat.draft.weekday.thursday',
  'chat.draft.weekday.friday',
  'chat.draft.weekday.saturday',
  'chat.draft.weekday.sunday',
] as const satisfies readonly MessageId[];

/** Generate a read-marker key only from verified tenant and user identity. */
export function sessionReadStorageKey(tenantId: string, userId: string): string {
  return tenantUserStorageKey(tenantId, userId, 'session-read');
}

/**
 * 读取租户/用户的会话已读标记；显式身份缺失、旧键或损坏 JSON 都只返回空集合。
 * 函数只读浏览器存储，不会把旧无租户键迁入新命名空间。
 */
export function loadSessionReadTimes(tenantId: string, userId: string): Record<string, string> {
  try {
    const key = sessionReadStorageKey(tenantId, userId);
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 写入租户/用户的会话已读标记；显式身份非法时在生成键阶段失败，不写入旧无租户位置。
 * 浏览器存储异常会继续抛出，调用方不得把失败当成成功。
 */
export function persistSessionReadTimes(
  tenantId: string,
  userId: string,
  values: Record<string, string>,
): void {
  const key = sessionReadStorageKey(tenantId, userId);
  window.localStorage.setItem(key, JSON.stringify(values));
}

export function isScheduledSession(session: ChatSession): boolean {
  return session.is_scheduled === true;
}

export function sessionHasUnreadReply(
  session: ChatSession,
  readTimes: Record<string, string>,
  activeSessionId?: string,
): boolean {
  if (session.id === activeSessionId) return false;
  const summary = session.summary || session.last_agent_question || '';
  if (!summary) return false;
  if (session.status === 'running' || session.status === 'executing') return false;
  const updatedAt = Date.parse(session.updated_at || '');
  const readAt = Date.parse(readTimes[session.id] || '');
  return Number.isFinite(updatedAt) && (!Number.isFinite(readAt) || updatedAt > readAt + 1000);
}

export function draftConversationKey(
  tenantId: string,
  userId: string,
  agentId: string,
): string {
  return `draft:${tenantUserStorageKey(tenantId, userId, agentId)}`;
}

export function isDraftConversationKey(id: string): boolean {
  return id.startsWith('draft:');
}

export function isMissingChatSessionError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** Generate a model preference key only from verified tenant and user identity. */
export function modelStorageKey(tenantId: string, userId: string): string {
  return tenantUserStorageKey(tenantId, userId, 'model-config');
}

/** 返回模型业务名称；无名称时使用当前界面的稳定默认标签。 */
export function modelDisplayName(
  model: { name?: string; model?: string },
  translate: ChatTranslate,
): string {
  return (model.name || model.model || translate('chat.composer.default')).trim();
}

/** 返回模型技术标识和默认状态；模型值保持原样，产品标签按当前语言输出。 */
export function modelDetailText(
  model: { name?: string; model?: string; provider?: string; is_default?: boolean },
  translate: ChatTranslate,
): string {
  const detail = model.model && model.model !== model.name ? model.model : model.provider || '';
  return model.is_default
    ? [detail, translate('chat.composer.default')].filter(Boolean).join(' · ')
    : detail;
}

export function normalizeMessageText(value?: string): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

export function hasRenderableStreamingText(value?: string): boolean {
  return Array.from(normalizeMessageText(value)).length >= 2;
}

export function isQueuedChatMessage(messageItem: ChatMessage): boolean {
  return messageItem.role === 'user' && messageItem.metadata?.queued === true;
}

export function placeQueuedMessagesLast(messages: ChatMessage[]): ChatMessage[] {
  const timeline: ChatMessage[] = [];
  const queued: ChatMessage[] = [];
  const queuedTurnIds = new Set<string>();

  messages.forEach((messageItem) => {
    if (!isQueuedChatMessage(messageItem)) {
      timeline.push(messageItem);
      return;
    }
    const identity = messageItem.turnId || messageItem.id;
    if (queuedTurnIds.has(identity)) return;
    queuedTurnIds.add(identity);
    queued.push(messageItem);
  });

  return [...timeline, ...queued];
}

function renderBareLinks(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
  const trailingPunctuation = /[.,!?;:\uff0c\u3002\uff01\uff1f\uff1b\uff1a\u3001)\]}>]+$/;
  let cursor = 0;
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const candidate = match[0];
    const label = candidate.replace(trailingPunctuation, '');
    if (!label) continue;
    const href = safeExternalHttpUrl(/^www\./i.test(label) ? `https://${label}` : label);
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    if (href) {
      nodes.push(
        <a key={`${keyPrefix}-url-${index}`} href={href} target="_blank" rel="noreferrer">
          {label}
        </a>,
      );
    } else {
      nodes.push(label);
    }
    const trailing = candidate.slice(label.length);
    if (trailing) nodes.push(trailing);
    cursor = match.index + candidate.length;
    index += 1;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export type MarkdownRenderOptions = {
  renderInternalLink?: (link: { label: string; href: string; key: string }) => ReactNode;
  translate?: ChatTranslate;
};

function safeExternalHttpUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** 渲染用户或 Agent 原文中的安全图片；alt 原文保持不变，宿主链接 ARIA 由语义消息生成。 */
function ExternalMarkdownImage({
  alt,
  src,
  translate,
}: {
  alt: string;
  src: string;
  translate?: ChatTranslate;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <span title={src}>{alt}</span>;
  }

  return (
    <a
      className={CHAT_MARKDOWN_IMAGE_LINK_CLASS}
      href={src}
      target="_blank"
      rel="noreferrer"
      {...(translate
        ? { 'aria-label': translate('chat.markdown.viewImage', { alt }) }
        : {})}
    >
      <img
        className={CHAT_MARKDOWN_IMAGE_CLASS}
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </a>
  );
}

export function renderInlineMarkdown(
  text: string,
  keyPrefix: string,
  options: MarkdownRenderOptions = {},
): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]*`|\*\*[^*]+?\*\*|!?\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))+\))/g;
  let cursor = 0;
  let index = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(...renderBareLinks(text.slice(cursor, match.index), `${keyPrefix}-${index}`));
    }
    const token = match[0];
    const key = `${keyPrefix}-inline-${index}`;
    if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={key}>{renderInlineMarkdown(token.slice(2, -2), key, options)}</strong>);
    } else {
      const image = token.match(/^!\[([^\]]*)\]\(((?:[^()\n]|\([^()\n]*\))+)\)$/);
      if (image) {
        const alt = image[1].trim();
        const src = safeExternalHttpUrl(image[2].trim());
        if (src) {
          nodes.push(
            <ExternalMarkdownImage key={key} src={src} alt={alt} translate={options.translate} />,
          );
        } else {
          nodes.push(<span key={key}>{alt}</span>);
        }
        cursor = match.index + token.length;
        index += 1;
        continue;
      }
      const link = token.match(/^\[([^\]]*)\]\(((?:[^()\n]|\([^()\n]*\))+)\)$/);
      if (link) {
        const href = link[2].trim();
        const label = link[1] || href;
        const safeHref = safeExternalHttpUrl(href);
        if (safeHref) {
          nodes.push(
            <a key={key} href={safeHref} target="_blank" rel="noreferrer">
              {label}
            </a>,
          );
        } else if (options.renderInternalLink) {
          nodes.push(options.renderInternalLink({ label, href, key }));
        } else {
          nodes.push(
            <span key={key} className="md-link-label" title={href}>
              {label}
            </span>,
          );
        }
      } else {
        nodes.push(token);
      }
    }
    cursor = match.index + token.length;
    index += 1;
  }

  if (cursor < text.length) {
    nodes.push(...renderBareLinks(text.slice(cursor), `${keyPrefix}-${index}`));
  }
  return nodes;
}

function softLineBreakSeparator(previousLine: string, currentLine: string): string {
  const previous = previousLine.trimEnd();
  const current = currentLine.trimStart();
  if (!previous || !current) return '';

  const previousCharacter = previous.charAt(previous.length - 1);
  const currentCharacter = current.charAt(0);
  const cjkCharacter = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  return cjkCharacter.test(previousCharacter) || cjkCharacter.test(currentCharacter) ? '' : ' ';
}

function renderInlineLines(
  lines: string[],
  keyPrefix: string,
  preserveLineBreaks: boolean,
  options: MarkdownRenderOptions,
): ReactNode[] {
  return lines.flatMap((line, lineIndex) => {
    const renderedLine = preserveLineBreaks ? line : line.trim();
    const nodes = renderInlineMarkdown(renderedLine, `${keyPrefix}-line-${lineIndex}`, options);
    if (lineIndex === 0) return nodes;
    const separator = preserveLineBreaks
      ? <br key={`${keyPrefix}-br-${lineIndex}`} />
      : softLineBreakSeparator(lines[lineIndex - 1], line);
    return [separator, ...nodes];
  });
}

type MarkdownTableAlign = 'left' | 'center' | 'right';

function splitMarkdownTableRow(row: string): string[] {
  let text = row.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);

  const cells: string[] = [];
  let current = '';
  let inCode = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '`') {
      inCode = !inCode;
      current += char;
      continue;
    }
    if (char === '\\' && text[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (char === '|' && !inCode) {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')));
}

function markdownTableAlign(separatorCell: string): MarkdownTableAlign {
  const normalized = separatorCell.replace(/\s+/g, '');
  if (normalized.startsWith(':') && normalized.endsWith(':')) return 'center';
  if (normalized.endsWith(':')) return 'right';
  return 'left';
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false;
  const header = lines[index].trim();
  if (!header.includes('|')) return false;
  return splitMarkdownTableRow(header).length >= 2 && isMarkdownTableSeparator(lines[index + 1]);
}

function renderMarkdownTable(
  lines: string[],
  startIndex: number,
  key: string,
  options: MarkdownRenderOptions,
): { node: ReactNode; nextIndex: number } {
  const header = splitMarkdownTableRow(lines[startIndex]);
  const separator = splitMarkdownTableRow(lines[startIndex + 1]);
  const aligns = separator.map(markdownTableAlign);
  const rows: string[][] = [];
  let index = startIndex + 2;

  while (index < lines.length) {
    const row = lines[index].trim();
    if (!row || !row.includes('|') || isMarkdownTableSeparator(row)) break;
    const cells = splitMarkdownTableRow(row);
    if (cells.length < 2) break;
    rows.push(cells);
    index += 1;
  }

  const columnCount = Math.max(header.length, separator.length, ...rows.map((row) => row.length));
  const cellStyle = (cellIndex: number) => ({ textAlign: (aligns[cellIndex] || 'left') as MarkdownTableAlign });
  const renderCells = (cells: string[], rowKey: string) =>
    Array.from({ length: columnCount }, (_, cellIndex) => (
      <td key={`${rowKey}-${cellIndex}`} style={cellStyle(cellIndex)}>
        {renderInlineMarkdown(cells[cellIndex] || '', `${rowKey}-${cellIndex}`, options)}
      </td>
    ));

  return {
    nextIndex: index,
    node: (
      <div key={key} className={CHAT_MD_TABLE_SCROLL_CLASS}>
        <table className={CHAT_MD_TABLE_CLASS}>
          <thead>
            <tr>
              {Array.from({ length: columnCount }, (_, cellIndex) => (
                <th key={`${key}-head-${cellIndex}`} style={cellStyle(cellIndex)}>
                  {renderInlineMarkdown(header[cellIndex] || '', `${key}-head-${cellIndex}`, options)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`${key}-row-${rowIndex}`}>{renderCells(row, `${key}-row-${rowIndex}`)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    ),
  };
}

function isBlockBoundary(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith('```') ||
    /^(-{3,}|\*{3,}|_{3,})$/.test(trimmed) ||
    /^#{1,6}\s+/.test(trimmed) ||
    /^>\s?/.test(trimmed) ||
    /^[-*]\s+/.test(trimmed) ||
    /^\d+[.)]\s+/.test(trimmed)
  );
}

export function renderMarkdownBlocks(
  content: string,
  preserveLineBreaks = true,
  options: MarkdownRenderOptions = {},
): ReactNode[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  let blockIndex = 0;
  let continuedOrderedListStart: number | null = null;

  const resetOrderedListSequence = () => {
    continuedOrderedListStart = null;
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    const key = `md-${blockIndex}`;
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (trimmed.startsWith('```')) {
      resetOrderedListSequence();
      const language = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(
        <CodeBlock key={key} className="md-code-block" code={codeLines.join('\n')} language={language || undefined} />,
      );
      blockIndex += 1;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      resetOrderedListSequence();
      blocks.push(<hr key={key} />);
      index += 1;
      blockIndex += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      resetOrderedListSequence();
      const level = Math.min(heading[1].length, 4) as 1 | 2 | 3 | 4;
      const Tag = `h${level}` as keyof JSX.IntrinsicElements;
      blocks.push(<Tag key={key}>{renderInlineMarkdown(heading[2], key, options)}</Tag>);
      index += 1;
      blockIndex += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      resetOrderedListSequence();
      const quoteLines: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index].trim())) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote key={key}>
          {renderMarkdownBlocks(quoteLines.join('\n'), preserveLineBreaks, options)}
        </blockquote>,
      );
      blockIndex += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      resetOrderedListSequence();
      const table = renderMarkdownTable(lines, index, key, options);
      blocks.push(table.node);
      index = table.nextIndex;
      blockIndex += 1;
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index].trim())) {
        items.push(lines[index].trim().replace(/^[-*]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={key}>
          {items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>
              {renderInlineMarkdown(item, `${key}-${itemIndex}`, options)}
            </li>
          ))}
        </ul>,
      );
      blockIndex += 1;
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items: Array<{ marker: number; content: string }> = [];
      while (index < lines.length && /^\d+[.)]\s+/.test(lines[index].trim())) {
        const item = lines[index].trim().match(/^(\d+)[.)]\s+(.+)$/);
        if (!item) break;
        items.push({ marker: Number(item[1]), content: item[2] });
        index += 1;
      }
      const explicitStart = items[0]?.marker || 1;
      const listStart: number = explicitStart === 1 && continuedOrderedListStart !== null
        ? continuedOrderedListStart
        : explicitStart;
      blocks.push(
        <ol key={key} start={listStart === 1 ? undefined : listStart}>
          {items.map((item, itemIndex) => (
            <li key={`${key}-${itemIndex}`}>
              {renderInlineMarkdown(item.content, `${key}-${itemIndex}`, options)}
            </li>
          ))}
        </ol>,
      );
      continuedOrderedListStart = listStart + items.length;
      blockIndex += 1;
      continue;
    }

    resetOrderedListSequence();
    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !isBlockBoundary(lines[index]) &&
      !isMarkdownTableStart(lines, index)
    ) {
      paragraphLines.push(lines[index]);
      index += 1;
    }
    blocks.push(
      <p key={key}>{renderInlineLines(paragraphLines, key, preserveLineBreaks, options)}</p>,
    );
    blockIndex += 1;
  }

  return blocks;
}

/** 渲染 raw Markdown 内容；仅图片宿主 ARIA 使用显式注入的产品翻译，不翻译正文或链接值。 */
export function MarkdownMessage({
  content,
  preserveLineBreaks = true,
  translate,
}: {
  content: string;
  preserveLineBreaks?: boolean;
  translate?: ChatTranslate;
}) {
  const { t } = useAppIntl();
  const activeTranslate = translate || t;
  return (
    <div className={CHAT_MARKDOWN_CLASS}>
      {renderMarkdownBlocks(content, preserveLineBreaks, { translate: activeTranslate })}
    </div>
  );
}

export function traceSummaryIconName(_summary: { state: TraceLine['state'] }): CotTraceIconName {
  return 'execute';
}

export function traceLineIconName(line: TraceLine): CotTraceIconName {
  if (line.icon) return line.icon;
  if (line.kind === 'decision') return 'judge';
  if (line.kind === 'tool') return 'tool';
  if (line.kind === 'code') return 'generated';
  if (line.kind === 'thinking') return 'loading';
  return 'advance';
}

export function parseMessageTime(value?: string): number {
  if (!value) return 0;
  const normalized = /(?:z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : 0;
}

function appendTurnAlias(aliases: string[], value: unknown): void {
  if (typeof value !== 'string') return;
  const normalized = value.trim();
  if (normalized && !aliases.includes(normalized)) aliases.push(normalized);
}

function metadataString(messageItem: ChatMessage, key: string): string | undefined {
  const value = messageItem.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function messageTurnAliases(messageItem: ChatMessage): string[] {
  const aliases: string[] = [];
  appendTurnAlias(aliases, messageItem.turnId);
  appendTurnAlias(aliases, messageItem.turn_id);
  appendTurnAlias(aliases, metadataString(messageItem, 'turn_id'));
  appendTurnAlias(aliases, metadataString(messageItem, 'user_message_id'));
  appendTurnAlias(aliases, metadataString(messageItem, 'client_turn_id'));
  appendTurnAlias(aliases, messageItem.serverMessageId);
  if (messageItem.role === 'user') appendTurnAlias(aliases, messageItem.id);
  return aliases;
}

function preferredTurnAlias(messageItem: ChatMessage, aliases: string[]): string | undefined {
  if (messageItem.role === 'user' && !messageItem.id.startsWith('local_')) return messageItem.id;
  return aliases[0];
}

export function buildTurnAliasMap(messages: ChatMessage[]): Map<string, string> {
  const parent = new Map<string, string>();

  const find = (value: string): string => {
    const current = parent.get(value);
    if (!current) {
      parent.set(value, value);
      return value;
    }
    if (current === value) return value;
    const root = find(current);
    parent.set(value, root);
    return root;
  };

  const union = (canonical: string, alias: string) => {
    const canonicalRoot = find(canonical);
    const aliasRoot = find(alias);
    if (canonicalRoot !== aliasRoot) {
      parent.set(aliasRoot, canonicalRoot);
    }
  };

  messages.forEach((messageItem) => {
    const aliases = messageTurnAliases(messageItem);
    const canonical = preferredTurnAlias(messageItem, aliases);
    if (!canonical) return;
    aliases.forEach((alias) => union(canonical, alias));
  });

  const result = new Map<string, string>();
  parent.forEach((_value, key) => {
    result.set(key, find(key));
  });
  return result;
}

export function canonicalTurnIdForValue(turnId: string | null | undefined, aliasMap: Map<string, string>): string | undefined {
  const normalized = typeof turnId === 'string' ? turnId.trim() : '';
  if (!normalized) return undefined;
  return aliasMap.get(normalized) || normalized;
}

export function canonicalMessageTurnId(messageItem: ChatMessage, aliasMap: Map<string, string>): string | undefined {
  const aliases = messageTurnAliases(messageItem);
  for (const alias of aliases) {
    const canonical = aliasMap.get(alias);
    if (canonical) return canonical;
  }
  return effectiveMessageTurnId(messageItem);
}

function latestUserMessageForTurn(slot: SessionSlot, turnId?: string | null): ChatMessage | undefined {
  const messages = [...slot.serverMessages, ...slot.realtimeMessages];
  const aliasMap = buildTurnAliasMap(messages);
  const canonicalTurnId = canonicalTurnIdForValue(turnId, aliasMap);
  const scoped = messages.filter((messageItem) => (
    messageItem.role === 'user'
    && (!canonicalTurnId || canonicalMessageTurnId(messageItem, aliasMap) === canonicalTurnId)
  ));
  const candidates = scoped.length
    ? scoped
    : messages.filter((messageItem) => messageItem.role === 'user');
  return candidates.sort((left, right) => parseMessageTime(right.created_at) - parseMessageTime(left.created_at))[0];
}

function timestampAfterMessage(messageItem?: ChatMessage): string {
  const baseTime = messageItem ? parseMessageTime(messageItem.created_at) : 0;
  return new Date((baseTime > 0 ? baseTime : Date.now()) + 1).toISOString();
}

function hasServerMessageForTurn(messageItem: ChatMessage, serverMessages: ChatMessage[]): boolean {
  const messages = [...serverMessages, messageItem];
  const aliasMap = buildTurnAliasMap(messages);
  const messageTurnId = canonicalMessageTurnId(messageItem, aliasMap);
  if (!messageTurnId) return false;
  return serverMessages.some(
    (serverMessage) => (
      canonicalMessageTurnId(serverMessage, aliasMap) === messageTurnId
      && serverMessage.role === messageItem.role
    ),
  );
}

export function sameRoleTurn(left: ChatMessage, right: ChatMessage): boolean {
  const aliasMap = buildTurnAliasMap([left, right]);
  const leftTurnId = canonicalMessageTurnId(left, aliasMap);
  const rightTurnId = canonicalMessageTurnId(right, aliasMap);
  return Boolean(leftTurnId && rightTurnId && leftTurnId === rightTurnId && left.role === right.role);
}

export function hasAssistantMessageForTurn(slot: SessionSlot, turnId: string): boolean {
  if (!turnId) return false;
  const messages = [...slot.serverMessages, ...slot.realtimeMessages];
  const aliasMap = buildTurnAliasMap(messages);
  const canonicalTurnId = canonicalTurnIdForValue(turnId, aliasMap);
  return messages.some((messageItem) => (
    messageItem.role === 'assistant'
    && !messageItem.isStreaming
    && canonicalMessageTurnId(messageItem, aliasMap) === canonicalTurnId
    && Boolean(normalizeMessageText(messageItem.content))
  ));
}

export function hasAssistantCarrierForTurn(slot: SessionSlot, turnId: string): boolean {
  if (!turnId) return false;
  const messages = [...slot.serverMessages, ...slot.realtimeMessages];
  const aliasMap = buildTurnAliasMap(messages);
  const canonicalTurnId = canonicalTurnIdForValue(turnId, aliasMap);
  return messages.some((messageItem) => (
    messageItem.role === 'assistant'
    && !messageItem.isStreaming
    && canonicalMessageTurnId(messageItem, aliasMap) === canonicalTurnId
    && (
      Boolean(normalizeMessageText(messageItem.content))
      || messageItem.isError
      || messageItem.id.startsWith('__trace_')
    )
  ));
}

export function streamingMessageId(sessionId: string, turnId?: string | null): string {
  const normalizedTurnId = typeof turnId === 'string' ? turnId.trim() : '';
  return normalizedTurnId ? `__streaming_${sessionId}_${normalizedTurnId}` : `__streaming_${sessionId}`;
}

export function isStreamingMessageId(messageId: string, sessionId: string): boolean {
  const prefix = `__streaming_${sessionId}`;
  return messageId === prefix || messageId.startsWith(`${prefix}_`);
}

export function upsertStreamingTracePlaceholder(slot: SessionSlot, sessionId: string, turnId: string): boolean {
  if (!turnId) return false;
  const streamId = streamingMessageId(sessionId, turnId);
  const streamingMessage: ChatMessage = {
    id: streamId,
    turnId,
    role: 'assistant',
    content: '',
    created_at: timestampAfterMessage(latestUserMessageForTurn(slot, turnId)),
    isStreaming: true,
  };
  const index = slot.realtimeMessages.findIndex((item) => item.id === streamId);
  if (index >= 0) {
    const current = slot.realtimeMessages[index];
    if (
      current.turnId === streamingMessage.turnId
      && current.isStreaming
      && current.content === streamingMessage.content
    ) {
      return false;
    }
    slot.realtimeMessages = [...slot.realtimeMessages];
    slot.realtimeMessages[index] = { ...current, ...streamingMessage, created_at: current.created_at || streamingMessage.created_at };
    return true;
  }
  slot.realtimeMessages = [...slot.realtimeMessages, streamingMessage];
  return true;
}

export function upsertTraceStatusPlaceholder(slot: SessionSlot, sessionId: string, turnId: string): boolean {
  if (!turnId) return false;
  const traceId = `__trace_${sessionId}_${turnId}`;
  const streamId = streamingMessageId(sessionId, turnId);
  const traceMessage: ChatMessage = {
    id: traceId,
    turnId,
    role: 'assistant',
    content: '',
    created_at: timestampAfterMessage(latestUserMessageForTurn(slot, turnId)),
    isStreaming: false,
  };
  const existingAliasMap = buildTurnAliasMap([...slot.serverMessages, ...slot.realtimeMessages, traceMessage]);
  const canonicalTraceTurnId = canonicalTurnIdForValue(turnId, existingAliasMap);
  const existingAssistantIndex = slot.realtimeMessages.findIndex((item) => (
    item.role === 'assistant'
    && item.id !== traceId
    && item.id !== streamId
    && canonicalMessageTurnId(item, existingAliasMap) === canonicalTraceTurnId
  ));
  if (existingAssistantIndex >= 0) return false;
  const index = slot.realtimeMessages.findIndex((item) => item.id === traceId);
  if (index >= 0) {
    const current = slot.realtimeMessages[index];
    if (current.turnId === traceMessage.turnId && current.content === traceMessage.content) return false;
    slot.realtimeMessages = [...slot.realtimeMessages];
    slot.realtimeMessages[index] = { ...current, ...traceMessage, created_at: current.created_at || traceMessage.created_at };
    return true;
  }
  const streamingIndex = slot.realtimeMessages.findIndex((item) => (
    item.id === streamId
    && canonicalMessageTurnId(item, existingAliasMap) === canonicalTraceTurnId
  ));
  if (streamingIndex >= 0) {
    const current = slot.realtimeMessages[streamingIndex];
    slot.realtimeMessages = slot.realtimeMessages.filter((item, itemIndex) => (
      itemIndex === streamingIndex
      || !(
        item.turnId === turnId
        && item.role === 'assistant'
        && (item.id === traceId || item.id === streamId)
      )
    ));
    const nextIndex = slot.realtimeMessages.findIndex((item) => item === current);
    slot.realtimeMessages[nextIndex] = {
      ...current,
      id: traceId,
      isStreaming: false,
      created_at: current.created_at || traceMessage.created_at,
    };
    return true;
  }
  slot.realtimeMessages = [
    ...slot.realtimeMessages.filter((item) => item.id !== streamId || item.turnId !== turnId),
    traceMessage,
  ];
  return true;
}

export function explicitMessageTurnId(messageItem: ChatMessage): string | undefined {
  const camelTurnId = typeof messageItem.turnId === 'string' ? messageItem.turnId.trim() : '';
  if (camelTurnId) return camelTurnId;
  const snakeTurnId = typeof messageItem.turn_id === 'string' ? messageItem.turn_id.trim() : '';
  return snakeTurnId || undefined;
}

export function effectiveMessageTurnId(messageItem: ChatMessage): string | undefined {
  return explicitMessageTurnId(messageItem) || (messageItem.role === 'user' ? messageItem.id : undefined);
}

export function explicitStreamTurnId(data: Record<string, unknown>, fallbackTurnId: string): string {
  const turnId = typeof data.turn_id === 'string' ? data.turn_id.trim() : '';
  if (turnId) return turnId;
  const userMessageId = typeof data.user_message_id === 'string' ? data.user_message_id.trim() : '';
  if (userMessageId) return userMessageId;
  return fallbackTurnId;
}

export function eventTraceTurnId(event: ChatSessionEventRead): string {
  const data = isPlainRecord(event.data) ? event.data : {};
  const explicit = explicitStreamTurnId(data, '');
  if (explicit) return explicit;
  if (event.event === 'user_message_received') {
    return typeof data.message_id === 'string' ? data.message_id.trim() : '';
  }
  return '';
}

export function normalizeSessionEventForStream(event: ChatSessionEventRead): StreamEvent {
  const data = isPlainRecord(event.data) ? event.data : {};
  if (event.event === 'stream_status') {
    return { event: 'status', data };
  }
  if (event.event === 'router_decision_created') {
    return { event: 'router_decision', data };
  }
  if (event.event === 'assistant_message_created') {
    const content = typeof data.reply === 'string' ? data.reply : '';
    return { event: 'stream_replace', data: { ...data, content } };
  }
  return { event: event.event, data };
}

export function isTerminalSessionEvent(
  event: ChatSessionEventRead,
  isTerminalStreamEvent: (event: ChatSessionEventRead) => boolean,
): boolean {
  if (event.event === 'assistant_message_created') return true;
  return isTerminalStreamEvent(event);
}

export function shouldDeferPersistedEventToLiveStream(
  eventName: string,
  liveStreamOwnsTurn: boolean,
): boolean {
  if (!liveStreamOwnsTurn) return false;
  if (eventName === 'assistant_message_created') return false;
  return !STREAM_TERMINAL_EVENTS.has(eventName);
}

export function attachTurnIdsToServerMessages(
  serverMessages: ChatMessage[],
  realtimeMessages: ChatMessage[],
): ChatMessage[] {
  const realtimeTurnIdsByServerId = new Map(
    realtimeMessages
      .filter((item) => item.turnId && item.serverMessageId)
      .map((item) => [item.serverMessageId as string, item.turnId as string]),
  );

  return serverMessages.map((messageItem) => {
    const turnId = explicitMessageTurnId(messageItem) || realtimeTurnIdsByServerId.get(messageItem.id);
    if (turnId) return { ...messageItem, turnId };
    if (messageItem.role === 'user') return { ...messageItem, turnId: messageItem.id };
    return messageItem;
  });
}

function shouldKeepRealtimeMessage(
  messageItem: ChatMessage,
  serverMessages: ChatMessage[],
  latestServerTime: number,
  activeTurnId?: string | null,
): boolean {
  if (messageItem.role === 'user' && messageItem.metadata?.queued === true) return true;
  if (messageItem.isStreaming) {
    const aliasMap = buildTurnAliasMap([...serverMessages, messageItem]);
    const messageTurnId = canonicalMessageTurnId(messageItem, aliasMap);
    const activeCanonicalTurnId = canonicalTurnIdForValue(activeTurnId, aliasMap);
    return !messageTurnId || !activeCanonicalTurnId || messageTurnId === activeCanonicalTurnId;
  }
  if (hasServerMessageForTurn(messageItem, serverMessages)) return false;
  if (messageItem.serverMessageId && serverMessages.some((serverMessage) => serverMessage.id === messageItem.serverMessageId)) {
    return false;
  }
  if (
    messageItem.role === 'assistant'
    && (
      Boolean(normalizeMessageText(messageItem.content))
      || messageItem.isError
      || messageItem.id.startsWith('__trace_')
    )
  ) {
    return true;
  }
  if (activeTurnId) {
    const aliasMap = buildTurnAliasMap([...serverMessages, messageItem]);
    const messageTurnId = canonicalMessageTurnId(messageItem, aliasMap);
    const activeCanonicalTurnId = canonicalTurnIdForValue(activeTurnId, aliasMap);
    if (messageTurnId && activeCanonicalTurnId && messageTurnId === activeCanonicalTurnId) return true;
  }
  if (!latestServerTime) return true;
  return parseMessageTime(messageItem.created_at) > latestServerTime;
}

export { shouldKeepRealtimeMessage, hasServerMessageForTurn, latestUserMessageForTurn, timestampAfterMessage };

export function computeMergedMessages(slot: SessionSlot, activeTurnId?: string | null): ChatMessage[] {
  const serverIds = new Set(slot.serverMessages.map((item) => item.id));
  const latestServerTime = Math.max(0, ...slot.serverMessages.map((item) => parseMessageTime(item.created_at)));
  const extras = slot.realtimeMessages.filter((item) => {
    if (serverIds.has(item.id)) return false;
    return shouldKeepRealtimeMessage(item, slot.serverMessages, latestServerTime, activeTurnId);
  });
  const combined = [
    ...slot.serverMessages.map((messageItem, index) => ({ messageItem, index, source: 'server' as const })),
    ...extras.map((messageItem, index) => ({ messageItem, index: slot.serverMessages.length + index, source: 'realtime' as const })),
  ];
  const aliasMap = buildTurnAliasMap(combined.map((entry) => entry.messageItem));
  const turnStarts = new Map<string, number>();
  combined.forEach(({ messageItem }) => {
    if (messageItem.role !== 'user') return;
    const turnId = canonicalMessageTurnId(messageItem, aliasMap);
    if (!turnId) return;
    const createdAt = parseMessageTime(messageItem.created_at);
    const previous = turnStarts.get(turnId);
    if (previous === undefined || createdAt < previous) {
      turnStarts.set(turnId, createdAt);
    }
  });
  combined.forEach(({ messageItem }) => {
    const turnId = canonicalMessageTurnId(messageItem, aliasMap);
    if (!turnId || turnStarts.has(turnId)) return;
    turnStarts.set(turnId, parseMessageTime(messageItem.created_at));
  });
  const roleOrder: Record<ChatMessage['role'], number> = {
    user: 0,
    assistant: 1,
    tool: 2,
    system: 3,
  };

  const sorted = combined
    .sort((left, right) => {
      const leftQueued = left.messageItem.role === 'user' && left.messageItem.metadata?.queued === true;
      const rightQueued = right.messageItem.role === 'user' && right.messageItem.metadata?.queued === true;
      if (leftQueued !== rightQueued) return leftQueued ? 1 : -1;
      const leftTurnId = canonicalMessageTurnId(left.messageItem, aliasMap);
      const rightTurnId = canonicalMessageTurnId(right.messageItem, aliasMap);
      const leftTurnStart = leftTurnId ? turnStarts.get(leftTurnId) : undefined;
      const rightTurnStart = rightTurnId ? turnStarts.get(rightTurnId) : undefined;
      const leftSortTime = leftTurnStart ?? parseMessageTime(left.messageItem.created_at);
      const rightSortTime = rightTurnStart ?? parseMessageTime(right.messageItem.created_at);
      if (leftSortTime !== rightSortTime) return leftSortTime - rightSortTime;
      if (leftTurnId && leftTurnId === rightTurnId && left.messageItem.role !== right.messageItem.role) {
        return (roleOrder[left.messageItem.role] ?? 3) - (roleOrder[right.messageItem.role] ?? 3);
      }
      return (
        parseMessageTime(left.messageItem.created_at) - parseMessageTime(right.messageItem.created_at) ||
        left.index - right.index
      );
    });

  const selectedAssistantByTurn = new Map<string, { messageItem: ChatMessage; index: number; source: 'server' | 'realtime' }>();
  const assistantRank = (entry: { messageItem: ChatMessage; source: 'server' | 'realtime' }) => {
    const content = normalizeMessageText(entry.messageItem.content);
    let rank = 0;
    if (entry.source === 'server') rank += 100;
    if (content) rank += 60;
    if (entry.messageItem.isStreaming && (!activeTurnId || entry.messageItem.turnId === activeTurnId)) rank += 40;
    if (!entry.messageItem.isStreaming) rank += 10;
    return rank;
  };
  sorted.forEach((entry) => {
    if (entry.messageItem.role !== 'assistant') return;
    const turnId = canonicalMessageTurnId(entry.messageItem, aliasMap);
    if (!turnId) return;
    const previous = selectedAssistantByTurn.get(turnId);
    if (!previous || assistantRank(entry) >= assistantRank(previous)) {
      selectedAssistantByTurn.set(turnId, entry);
    }
  });

  return sorted
    .filter((entry) => {
      if (entry.messageItem.role !== 'assistant') return true;
      const turnId = canonicalMessageTurnId(entry.messageItem, aliasMap);
      if (!turnId) return true;
      return selectedAssistantByTurn.get(turnId)?.messageItem === entry.messageItem;
    })
    .map((item) => item.messageItem);
}

/** 将流式状态码映射为当前语言的产品状态；服务端自带自然语言不直接进入产品 chrome。 */
function publicStreamPhase(data: Record<string, unknown>, translate: ChatTranslate): string {
  const phase = typeof data.phase === 'string' ? data.phase : '';
  if (phase === 'error') return translate('chat.trace.statusError');
  if (phase === 'preparing') return translate('chat.trace.preparing');
  if (phase === 'scheduled_task_draft') return translate('chat.trace.scheduledDraft');
  if (isKnowledgeTracePhase(phase)) return knowledgeTraceText(data, translate);
  return translate('chat.trace.thinking');
}

export { publicStreamPhase };

type RecoverableTraceProgress = {
  id?: string;
  kind?: string;
  text?: string;
  detail?: string | null;
  code?: string | null;
  output?: string | null;
  state?: string;
};

function hasRecoverableTraceProgress(lines: RecoverableTraceProgress[]): boolean {
  return lines.some((line) => {
    if (!line) return false;
    if (line.state && line.state !== 'running') return false;
    if (line.detail || line.code || line.output) return true;
    if (line.kind && line.kind !== 'decision') return true;
    const text = String(line.text || '').trim();
    return Boolean(text);
  });
}

export function hasRecoverableEventProgress(events: ChatSessionEventRead[]): boolean {
  return events.some((event) => {
    if (event.event === 'memory_recalled') return false;
    if (event.event === 'router_decision_created') {
      const data = isPlainRecord(event.data) ? event.data : {};
      const intent = typeof data.user_intent === 'string' ? data.user_intent.trim() : '';
      const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
      const decision = typeof data.decision === 'string' ? data.decision.trim() : '';
      return Boolean(intent || reason || decision);
    }
    return true;
  });
}

export function isRecoverableRunningTrace(row: { completed_at?: string | null; lines: RecoverableTraceProgress[]; started_at: string }): boolean {
  if (row.completed_at) return false;
  const startedAt = parseMessageTime(row.started_at);
  if (startedAt <= 0) return false;
  if (Date.now() - startedAt > CHAT_TRACE_RECOVERY_WINDOW_MS) return false;
  const lines = row.lines || [];
  return hasRecoverableTraceProgress(lines);
}

const KNOWLEDGE_TRACE_PHASES = new Set([
  'knowledge',
  'okf_route',
  'okf_only',
  'document_route',
  'document_route_lexical',
  'bucket_route',
  'bucket_route_lexical',
  'section_expand',
  'read_chunks',
  'evidence_pack',
  'no_visible_knowledge',
  'no_documents',
  'no_buckets',
]);

export function isKnowledgeTracePhase(phase: string): boolean {
  return KNOWLEDGE_TRACE_PHASES.has(phase);
}

/** 返回知识检索产品状态；服务端自然语言留在协议数据中，不直接覆盖本地化 chrome。 */
export function knowledgeTraceText(data: Record<string, unknown>, translate: ChatTranslate): string {
  void data;
  return translate('chat.trace.readKnowledge');
}

export function knowledgeTraceLineId(data: Record<string, unknown>): string {
  const rawQuery = isPlainRecord(data.query) && typeof data.query.query === 'string'
    ? data.query.query
    : typeof data.query === 'string'
      ? data.query
      : '';
  const query = rawQuery.trim().replace(/\s+/g, ' ');
  return query ? `knowledge_lookup_${query}` : 'knowledge_lookup';
}

/** 生成知识检索明细；查询值保持原样，计数标签使用当前 locale 的 ICU 消息。 */
export function knowledgeTraceDetail(
  data: Record<string, unknown>,
  translate: ChatTranslate,
): string | undefined {
  const query = isPlainRecord(data.query) && typeof data.query.query === 'string' ? data.query.query : '';
  const parts = [
    query ? translate('chat.trace.query', { query }) : '',
    typeof data.selected_count === 'number'
      ? translate('chat.trace.knowledgeGraphMatches', { count: data.selected_count })
      : '',
    typeof data.candidate_count === 'number'
      ? translate('chat.trace.candidateCount', { count: data.candidate_count })
      : '',
    typeof data.chunk_count === 'number'
      ? translate('chat.trace.chunkCount', { count: data.chunk_count })
      : '',
    typeof data.evidence_count === 'number'
      ? translate('chat.trace.evidenceCount', { count: data.evidence_count })
      : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/** 生成知识结果明细；数组长度按当前语言格式化，检索结果自身不被翻译。 */
export function knowledgeResultTraceDetail(
  data: Record<string, unknown>,
  translate: ChatTranslate,
): string | undefined {
  const concepts = Array.isArray(data.selected_concepts) ? data.selected_concepts.length : 0;
  const chunks = Array.isArray(data.chunks) ? data.chunks.length : 0;
  const evidence = Array.isArray(data.evidence_pack) ? data.evidence_pack.length : 0;
  const parts = [
    concepts ? translate('chat.trace.knowledgeGraphMatches', { count: concepts }) : '',
    chunks ? translate('chat.trace.chunkCount', { count: chunks }) : '',
    evidence ? translate('chat.trace.evidenceCount', { count: evidence }) : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

export function normalizeTraceSkill(value: unknown): TraceSkill | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const skillId = typeof item.skillId === 'string' ? item.skillId : '';
  if (!skillId) return null;
  return {
    skillId,
    name: typeof item.name === 'string' ? item.name : skillId,
    stepId: typeof item.stepId === 'string' ? item.stepId : undefined,
    state: typeof item.state === 'string' ? item.state : undefined,
  };
}

/** 将 SOP 生命周期枚举转换为当前语言的产品标签，技能名称仍保持 raw。 */
export function streamSkillLabel(
  data: Record<string, unknown>,
  skill: TraceSkill,
  translate: ChatTranslate,
): string {
  if (skill.state === 'suspended') return translate('chat.trace.skillSuspended');
  if (skill.state === 'pending') return translate('chat.trace.skillPending');
  const decision = typeof data.runtimeDecision === 'string' ? data.runtimeDecision : '';
  const fromSkillId = typeof data.fromSkillId === 'string' ? data.fromSkillId : '';
  const toSkillId = typeof data.toSkillId === 'string' ? data.toSkillId : '';
  if (decision === 'start_skill' || decision === 'start_new_task') return translate('chat.trace.skillSelected');
  if (decision === 'suspend_current_and_start_new_skill') return translate('chat.trace.skillSwitched');
  if (
    (decision === 'answer_related_question_then_resume' || decision === 'answer_chitchat_then_resume')
    && fromSkillId
    && toSkillId
    && fromSkillId !== toSkillId
  ) return translate('chat.trace.skillSwitched');
  if (decision === 'exit_current_skill') return translate('chat.trace.skillResumed');
  return translate('chat.trace.skillAdvanced');
}

export function normalizeTraceTool(value: unknown): TraceTool | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const toolId = typeof item.toolId === 'string' ? item.toolId : '';
  if (!toolId) return null;
  return {
    toolId,
    toolCallId: typeof item.toolCallId === 'string' ? item.toolCallId : undefined,
    toolName: typeof item.toolName === 'string' ? item.toolName : toolId,
    rawToolName: typeof item.rawToolName === 'string' ? item.rawToolName : toolId,
    success: typeof item.success === 'boolean' ? item.success : undefined,
    isError: typeof item.isError === 'boolean' ? item.isError : undefined,
    content: item.content,
  };
}

function shortTraceValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/** 生成工具 trace 明细；工具名、来源和 provider 字段属于 raw 诊断值，仅状态标签本地化。 */
export function toolTraceDetail(tool: TraceTool, translate: ChatTranslate): string | undefined {
  const content = tool.content && typeof tool.content === 'object' ? tool.content as Record<string, unknown> : null;
  const data = content?.data && typeof content.data === 'object' ? content.data as Record<string, unknown> : null;
  const parts = [
    tool.rawToolName && tool.rawToolName !== tool.toolName ? tool.rawToolName : '',
    shortTraceValue(data?.source),
    data?.found === false ? translate('chat.trace.notFound') : data?.found === true ? translate('chat.trace.found') : '',
    shortTraceValue(data?.miss_reason),
    shortTraceValue(data?.recommendation),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** 生成反思诊断明细；工具、SOP 和步骤 ID 属于 raw 诊断值，产品标签按当前语言输出。 */
export function reflectionTraceDetail(
  data: Record<string, unknown>,
  translate: ChatTranslate,
): string | undefined {
  const parts = [
    typeof data.reason === 'string' ? data.reason : '',
    typeof data.target_tool_name === 'string'
      ? translate('chat.trace.targetTool', { toolName: data.target_tool_name })
      : '',
    typeof data.target_skill_id === 'string'
      ? translate('chat.trace.targetSop', { skillId: data.target_skill_id })
      : '',
    typeof data.target_step_id === 'string'
      ? translate('chat.trace.targetStep', { stepId: data.target_step_id })
      : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** 将错误事件代码映射为稳定产品文案；错误代码和类型作为 raw 参数保留诊断能力。 */
function streamErrorText(
  data: Record<string, unknown>,
  eventName: string,
  translate: ChatTranslate,
): string {
  const code = typeof data.code === 'string' ? data.code.trim() : '';
  if (code === 'LLM_ERROR') return translate('chat.trace.modelCallFailed');
  if (eventName === 'stream_interrupted') return translate('chat.trace.generationInterrupted');
  if (code) return translate('chat.trace.executionFailedCode', { code });
  const errorType = typeof data.error_type === 'string' ? data.error_type.trim() : '';
  return errorType
    ? translate('chat.trace.executionFailedType', { errorType })
    : translate('chat.trace.executionFailed');
}

function streamErrorDetail(data: Record<string, unknown>): string | undefined {
  const parts = [
    typeof data.code === 'string' ? data.code.trim() : '',
    typeof data.error_type === 'string' ? data.error_type.trim() : '',
    typeof data.message === 'string' ? data.message.trim() : '',
    typeof data.reason === 'string' ? data.reason.trim() : '',
    typeof data.text === 'string' ? data.text.trim() : '',
  ].filter(Boolean);
  const deduped = parts.filter((part, index) => parts.indexOf(part) === index);
  return deduped.length > 0 ? deduped.join(' · ').slice(0, 2000) : undefined;
}

/** 创建失败 trace 行；用户可见前缀本地化，服务端错误详情保持原始诊断值。 */
export function streamErrorTraceLine(
  data: Record<string, unknown>,
  eventName: string,
  translate: ChatTranslate,
): TraceLine {
  const code = typeof data.code === 'string' ? data.code.trim() : '';
  const errorType = typeof data.error_type === 'string' ? data.error_type.trim() : '';
  const key = code || errorType || eventName || 'error';
  return {
    id: eventName === 'stream_interrupted' ? 'generation_interrupted' : `error_${key}`,
    kind: 'decision',
    text: streamErrorText(data, eventName, translate),
    detail: streamErrorDetail(data),
    state: 'failed',
    icon: 'loading',
  };
}

/** 创建路由决策 trace 行；intent、decision、reason 和 ID 都是业务/诊断 raw 值。 */
export function routerDecisionTraceLine(data: Record<string, unknown>, translate: ChatTranslate): TraceLine {
  const intent = typeof data.user_intent === 'string' ? data.user_intent.trim() : '';
  const decision = typeof data.decision === 'string' ? data.decision.trim() : '';
  const skillId = typeof data.target_skill_id === 'string' ? data.target_skill_id.trim() : '';
  const stepId = typeof data.target_step_id === 'string' ? data.target_step_id.trim() : '';
  const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
  const detail = [
    reason,
    skillId ? translate('chat.trace.targetSop', { skillId }) : '',
    stepId ? translate('chat.trace.targetStep', { stepId }) : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    id: 'decision_router',
    kind: 'decision',
    text: intent || decision
      ? translate('chat.trace.intentWithValue', { intent: intent || decision })
      : translate('chat.trace.decideIntent'),
    detail: detail || undefined,
    state: 'completed',
    icon: 'judge',
  };
}

/** 创建步骤结果 trace 行；步骤、查询和回复值保持 raw，仅产品动作标签本地化。 */
export function stepResultTraceLine(data: Record<string, unknown>, translate: ChatTranslate): TraceLine {
  const toolCall = isPlainRecord(data.tool_call) ? data.tool_call : undefined;
  const knowledgeQuery = isPlainRecord(data.knowledge_query) ? data.knowledge_query : undefined;
  const nextStepId = typeof data.next_step_id === 'string' ? data.next_step_id.trim() : '';
  const reply = typeof data.reply === 'string' ? data.reply.trim() : '';
  const toolName = typeof toolCall?.name === 'string' ? toolCall.name.trim() : '';
  const knowledgeQueryText = typeof knowledgeQuery?.query === 'string' ? knowledgeQuery.query.trim() : '';
  const detail = [
    nextStepId ? translate('chat.trace.nextStepId', { stepId: nextStepId }) : '',
    knowledgeQueryText ? translate('chat.trace.query', { query: knowledgeQueryText }) : '',
    !toolName && !knowledgeQueryText && reply ? reply.slice(0, 80) : '',
  ].filter(Boolean).join(' · ');

  if (toolName) {
    return {
      id: `decision_step_tool_${toolName}`,
      kind: 'decision',
      text: translate('chat.trace.decideTool', { toolName }),
      detail: detail || undefined,
      state: 'running',
      icon: 'tool',
    };
  }
  if (knowledgeQueryText) {
    return {
      id: 'decision_step_knowledge',
      kind: 'decision',
      text: translate('chat.trace.decideKnowledge'),
      detail: detail || undefined,
      state: 'running',
      icon: 'advance',
    };
  }
  return {
    id: 'decision_step_result',
    kind: 'decision',
    text: nextStepId ? translate('chat.trace.decideNextStep') : translate('chat.trace.stepDecisionComplete'),
    detail: detail || undefined,
    state: 'completed',
    icon: 'advance',
  };
}

export function mergeTraceLine(existing: TraceLine, incoming: TraceLine): TraceLine {
  const keepExistingContent = incoming.provisional === true && existing.provisional !== true;
  const nextState =
    existing.state !== 'running' && incoming.state === 'running'
      ? existing.state
      : incoming.state;
  return {
    ...existing,
    ...incoming,
    text: keepExistingContent ? existing.text : incoming.text || existing.text,
    detail: keepExistingContent ? existing.detail : incoming.detail ?? existing.detail,
    code: incoming.code ?? existing.code,
    language: incoming.language ?? existing.language,
    output: incoming.output ?? existing.output,
    outputLanguage: incoming.outputLanguage ?? existing.outputLanguage,
    outputTitle: incoming.outputTitle ?? existing.outputTitle,
    state: nextState,
    provisional: incoming.provisional === true && existing.provisional === true,
  };
}

export function mergeTurnTraceSnapshot(existing: TurnTrace | undefined, incoming: TurnTrace): TurnTrace {
  if (!existing) return incoming;

  const existingById = new Map(existing.lines.map((line) => [line.id, line]));
  const incomingIds = new Set(incoming.lines.map((line) => line.id));
  const mergedLines = incoming.lines.map((line) => {
    const previous = existingById.get(line.id);
    return previous ? mergeTraceLine(previous, line) : line;
  });

  const incomingStillRunning = !incoming.completedAt;
  if (incomingStillRunning) {
    existing.lines.forEach((line) => {
      if (!incomingIds.has(line.id) && !line.placeholder) {
        mergedLines.push(line);
      }
    });
  }

  const startedAt = existing.startedAt > 0 && incoming.startedAt > 0
    ? Math.min(existing.startedAt, incoming.startedAt)
    : existing.startedAt || incoming.startedAt;

  return {
    lines: mergedLines.slice(-80),
    startedAt,
    completedAt: incoming.completedAt || existing.completedAt,
  };
}

export function formatTracePayload(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function tracePayloadLanguage(value: string): string {
  if (!value.trim()) return 'text';
  try {
    JSON.parse(value);
    return 'json';
  } catch {
    return 'text';
  }
}


/** 将 Harness 生命周期事件转换为 locale-aware trace；动作、名称、状态和错误详情保持 raw。 */
export function harnessEventTraceLine(
  eventName: string,
  data: Record<string, unknown>,
  translate: ChatTranslate,
): TraceLine | null {
  const frameId = typeof data.task_frame_id === 'string' && data.task_frame_id.trim()
    ? data.task_frame_id.trim()
    : 'current';
  const iteration = typeof data.iteration === 'number' || typeof data.iteration === 'string'
    ? String(data.iteration)
    : '';
  const toolName = typeof data.tool_name === 'string' ? data.tool_name.trim() : '';

  if (eventName === 'task_frame_started') {
    const kind = typeof data.kind === 'string' ? data.kind : 'conversation';
    const skillName = typeof data.skill_name === 'string' && data.skill_name.trim()
      ? data.skill_name.trim()
      : (typeof data.skill_id === 'string' ? data.skill_id.trim() : '');
    const stepId = typeof data.step_id === 'string' ? data.step_id.trim() : '';
    return {
      id: `harness_frame_${frameId}`,
      kind: kind === 'sop' ? 'skill' : 'decision',
      text: kind === 'sop' && skillName
        ? translate('chat.trace.sopFrameStart', { skillName })
        : translate('chat.trace.taskFrameStart'),
      detail: [
        kind === 'sop'
          ? translate('chat.trace.taskFrameSop')
          : translate('chat.trace.taskFrameConversation'),
        stepId ? translate('chat.trace.taskFrameStep', { stepId }) : '',
        typeof data.step_timeout_seconds === 'number'
          ? translate('chat.trace.taskFrameStepLimit', { seconds: data.step_timeout_seconds })
          : '',
        typeof data.harness_max_actions === 'number'
          ? translate('chat.trace.taskFrameActionLimit', { count: data.harness_max_actions })
          : '',
      ]
        .filter(Boolean)
        .join(' · '),
      state: 'running',
      icon: kind === 'sop' ? 'advance' : 'execute',
    };
  }
  if (eventName === 'harness_step_timeout') {
    const timeoutSeconds = typeof data.timeout_seconds === 'number' ? data.timeout_seconds : undefined;
    const actionCount = typeof data.action_count === 'number' ? data.action_count : undefined;
    return {
      id: `harness_timeout_${frameId}`,
      kind: 'skill',
      text: translate('chat.trace.sopStepTimeout'),
      detail: [
        timeoutSeconds === undefined ? '' : translate('chat.trace.taskFrameTimeoutLimit', { seconds: timeoutSeconds }),
        actionCount === undefined ? '' : translate('chat.trace.taskFrameActionsExecuted', { count: actionCount }),
      ].filter(Boolean).join(' · '),
      state: 'failed',
      icon: 'loading',
    };
  }
  if (eventName === 'task_frame_finished') {
    const kind = typeof data.kind === 'string' ? data.kind : 'conversation';
    const skillName = typeof data.skill_name === 'string' && data.skill_name.trim()
      ? data.skill_name.trim()
      : (typeof data.skill_id === 'string' ? data.skill_id.trim() : '');
    const stepId = typeof data.step_id === 'string' ? data.step_id.trim() : '';
    const status = typeof data.status === 'string' ? data.status : 'completed';
    const failed = ['failed', 'blocked', 'cancelled'].includes(status);
    const actionCount = typeof data.action_count === 'number' ? data.action_count : undefined;
    const text = kind === 'sop' && skillName
      ? (failed
        ? translate('chat.trace.sopFailed', { skillName })
        : (status === 'awaiting_user'
          ? translate('chat.trace.sopAwaitingUser', { skillName })
          : translate('chat.trace.sopCompleted', { skillName })))
      : (failed ? translate('chat.trace.taskFailed') : translate('chat.trace.taskCompleted'));
    return {
      id: `harness_frame_${frameId}`,
      kind: kind === 'sop' ? 'skill' : 'decision',
      text,
      detail: [
        translate('chat.trace.taskFrameStatus', { status }),
        stepId ? translate('chat.trace.taskFrameStep', { stepId }) : '',
        actionCount === undefined ? '' : translate('chat.trace.taskFrameActionsExecuted', { count: actionCount }),
      ]
        .filter(Boolean)
        .join(' · '),
      state: failed ? 'failed' : (status === 'awaiting_user' ? 'running' : 'completed'),
      icon: failed ? 'loading' : 'execute',
    };
  }
  if (eventName === 'harness_action_created') {
    const action = typeof data.action === 'string' ? data.action : '';
    if (action === 'tool') {
      return {
        id: `harness_action_${frameId}_${iteration || 'current'}`,
        kind: 'tool',
        text: toolName
          ? translate('chat.trace.invokeCapability', { toolName })
          : translate('chat.trace.invokeCapabilityGeneric'),
        detail: iteration ? translate('chat.trace.taskFrameAction', { iteration }) : undefined,
        state: 'running',
        icon: 'tool',
      };
    }
    if (action === 'finish') {
      return {
        id: `harness_finish_${frameId}_${iteration || 'current'}`,
        kind: 'decision',
        text: translate('chat.trace.organizeTaskResult'),
        detail: iteration ? translate('chat.trace.taskFrameAction', { iteration }) : undefined,
        state: 'completed',
        icon: 'advance',
      };
    }
    return null;
  }
  if (eventName === 'harness_mcp_app_view') {
    const mcpApp = isPlainRecord(data.mcp_app)
      ? data.mcp_app as TraceLine['mcpApp']
      : undefined;
    if (!mcpApp) return null;
    const appToolName = typeof data.tool_name === 'string' ? data.tool_name : mcpApp.tool_name;
    return {
      id: `harness_mcp_app_${frameId}_${appToolName || 'view'}`,
      kind: 'tool',
      text: appToolName
        ? translate('chat.trace.showMcpApp', { toolName: appToolName })
        : translate('chat.trace.showMcpAppGeneric'),
      detail: translate('chat.trace.mcpAppDetail'),
      mcpApp,
      state: 'completed',
      icon: 'tool',
    };
  }
  if (eventName === 'harness_tool_completed') {
    const success = data.success === true;
    const result = isPlainRecord(data.result) ? data.result : {};
    const mcpApp = isPlainRecord(result.mcp_app)
      ? result.mcp_app as TraceLine['mcpApp']
      : undefined;
    const error = isPlainRecord(data.error) ? data.error : {};
    const detail = [
      typeof error.code === 'string' ? error.code : '',
      typeof error.message === 'string' ? error.message : '',
    ].filter(Boolean).join(' · ') || undefined;
    const output = formatTracePayload(data.result);
    return {
      id: `harness_action_${frameId}_${iteration || 'current'}`,
      kind: 'tool',
      text: toolName
        ? translate(success ? 'chat.trace.capabilityCompleted' : 'chat.trace.capabilityFailed', { toolName })
        : translate(success ? 'chat.trace.capabilityCompletedGeneric' : 'chat.trace.capabilityFailedGeneric'),
      detail,
      output: output || undefined,
      outputLanguage: output ? tracePayloadLanguage(output) : undefined,
      outputTitle: output ? translate('chat.trace.viewCapabilityResult') : undefined,
      collapsible: Boolean(output),
      mcpApp,
      state: success ? 'completed' : 'failed',
      icon: 'tool',
    };
  }
  return null;
}


export function generalSkillTraceDetail(data: Record<string, unknown>, phase: string): string | undefined {
  const review = isPlainRecord(data.review) ? data.review : undefined;
  if (phase.startsWith('reflection_')) {
    return [
      typeof review?.reason === 'string' ? review.reason : '',
      typeof review?.repair_hint === 'string' ? review.repair_hint : '',
    ]
      .filter(Boolean)
      .join(' · ') || undefined;
  }
  const detail = typeof data.rationale === 'string'
    ? data.rationale
    : typeof data.text === 'string'
      ? data.text
      : undefined;
  return detail?.trim() || undefined;
}

/** 提取通用技能输出并本地化折叠标题；代码、stdout、stderr 与结构化结果保持 raw。 */
export function generalSkillTraceOutput(
  data: Record<string, unknown>,
  phase: string,
  accumulatedText: string | undefined,
  translate: ChatTranslate,
): {
  output?: string;
  language?: string;
  title?: string;
} {
  if (phase === 'stdout_chunk') {
    const output = formatTracePayload(accumulatedText || data.stdout_preview || data.text);
    return output ? { output, language: tracePayloadLanguage(output), title: translate('chat.trace.viewRunOutput') } : {};
  }
  if (phase === 'stderr_chunk') {
    const output = formatTracePayload(accumulatedText || data.stderr_preview || data.text);
    return output ? { output, language: tracePayloadLanguage(output), title: translate('chat.trace.viewErrorOutput') } : {};
  }
  if (phase === 'code_finished' || phase === 'code_timeout') {
    const result: Record<string, unknown> = {};
    if ('return_code' in data) result.return_code = data.return_code;
    if ('structured_result' in data) result.structured_result = data.structured_result;
    if (typeof data.stdout_preview === 'string' && data.stdout_preview.trim()) result.stdout = data.stdout_preview;
    if (typeof data.stderr_preview === 'string' && data.stderr_preview.trim()) result.stderr = data.stderr_preview;
    const output = Object.keys(result).length > 0
      ? formatTracePayload(result)
      : formatTracePayload(data.stdout_preview || data.stderr_preview || data.text);
    return output
      ? {
        output,
        language: tracePayloadLanguage(output),
        title: phase === 'code_timeout'
          ? translate('chat.trace.viewTimeoutResult')
          : translate('chat.trace.viewExecutionResult'),
      }
      : {};
  }
  if (phase.startsWith('reflection_')) {
    const result: Record<string, unknown> = {};
    if ('structured_result' in data) result.structured_result = data.structured_result;
    if ('review' in data) result.review = data.review;
    if (typeof data.stdout_preview === 'string' && data.stdout_preview.trim()) result.stdout = data.stdout_preview;
    if (typeof data.stderr_preview === 'string' && data.stderr_preview.trim()) result.stderr = data.stderr_preview;
    const output = Object.keys(result).length > 0 ? formatTracePayload(result) : '';
    return output ? { output, language: tracePayloadLanguage(output), title: translate('chat.trace.viewValidationDetails') } : {};
  }
  return {};
}

export function traceLineAllowed(line: TraceLine, config: UIConfigRead): boolean {
  if (line.state === 'failed') return true;
  if (line.kind === 'thinking' || line.kind === 'decision') return config.show_thinking_trace;
  if (line.kind === 'code') return config.show_thinking_trace;
  if (line.kind === 'skill') return config.show_skill_trace;
  if (line.kind === 'tool') return config.show_tool_trace;
  return true;
}

/** 生成执行记录摘要；摘要标签本地化，trace 行的业务/诊断值不被改写。 */
export function traceSummary(
  trace: TurnTrace,
  lines: TraceLine[],
  translate: ChatTranslate,
): { text: string; state: TraceLine['state'] } {
  if (trace.completedAt) {
    if (lines.some((line) => line.state === 'failed')) {
      return { text: translate('chat.trace.executionProblem'), state: 'failed' };
    }
    return { text: translate('chat.trace.executionRecord'), state: 'completed' };
  }
  if (lines.some((line) => line.state === 'running')) {
    return { text: translate('chat.trace.executionRecord'), state: 'running' };
  }
  if (lines.some((line) => line.state === 'failed')) {
    return { text: translate('chat.trace.executionProblem'), state: 'failed' };
  }
  return { text: translate('chat.trace.executionRecord'), state: 'completed' };
}

export function traceDetails(lines: TraceLine[]): TraceLine[] {
  const details = lines.filter((line) => {
    if (line.placeholder) return false;
    if (line.kind === 'thinking' && line.state !== 'failed') return false;
    return true;
  });
  return details.length > 0
    ? details
    : lines.filter((line) => !line.placeholder && (line.kind !== 'thinking' || line.state === 'failed'));
}

export function canRateMessage(item: ChatMessage): boolean {
  return (
    item.role === 'assistant'
    && !item.isStreaming
    && !item.isError
    && !item.id.startsWith('__')
    && !item.id.startsWith('text_')
    && !item.id.startsWith('error_')
  );
}

export function stripTrailingCitationSummary(content: string): string {
  const citationHeading = '(?:参考来源|参考资料|引用来源|资料来源)';
  const labelFooter = new RegExp(
    `(?:^|\\n)\\s*${citationHeading}\\s*[:：]\\s*(?:\\[\\d+\\]\\s*)+\\s*$`,
    'u',
  );
  const citationSection = new RegExp(
    `(?:^|\\n)\\s{0,3}(?:#{1,6}\\s*)?${citationHeading}\\s*[:：]?\\s*`
      + `(?:\\n\\s*(?:[-*+]\\s+|\\d+[.)]\\s+)?\\[\\d+\\][^\\n]*)+\\s*$`,
    'u',
  );

  let stripped = content.trimEnd();
  let previous = '';
  while (stripped !== previous) {
    previous = stripped;
    stripped = stripped.replace(labelFooter, '').trimEnd();
    stripped = stripped.replace(citationSection, '').trimEnd();
  }
  return stripped;
}

function citationLabelsInContent(content: string): Set<number> {
  const labels = new Set<number>();
  content.replace(/\[(\d+)\]/g, (_match, value: string) => {
    const label = Number(value);
    if (Number.isInteger(label) && label >= 1) {
      labels.add(label);
    }
    return _match;
  });
  return labels;
}

function citationLabelNumber(citation: KnowledgeCitation, fallback: number): number {
  const labelText = citation.label || citation.id;
  const match = String(labelText || '').match(/\[(\d+)\]/);
  if (match) {
    const label = Number(match[1]);
    if (Number.isInteger(label) && label >= 1) {
      return label;
    }
  }
  return fallback;
}

export function knowledgeCitations(item: ChatMessage, content: string): KnowledgeCitation[] {
  const citations = item.metadata?.knowledge_citations;
  if (!Array.isArray(citations)) return [];
  const usedLabels = citationLabelsInContent(content);
  const seen = new Set<string>();
  const result: KnowledgeCitation[] = [];
  citations.forEach((citation, index) => {
    if (!citation || !citation.id) return;
    const labelNumber = citationLabelNumber(citation, index + 1);
    if (usedLabels.size > 0 && !usedLabels.has(labelNumber)) return;
    // A document can contribute multiple cited chunks with the same display
    // title. Prefer durable source identifiers so those cards are not merged.
    // Historical citations without source identifiers retain title-based
    // deduplication for backwards compatibility.
    const identity = citation.chunk_id
      ? `chunk:${citation.chunk_id}`
      : citation.concept_id
        ? `concept:${citation.concept_id}`
        : (citation.title || citation.section_path || citation.summary || citation.excerpt || citation.source_path || citation.id);
    const key = normalizeMessageText(identity).toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    result.push({ ...citation, label: `[${labelNumber}]` });
  });
  return result.sort((a, b) => citationLabelNumber(a, 0) - citationLabelNumber(b, 0));
}

export function scheduledDraftForMessage(item: ChatMessage): ScheduledTaskDraftRead | null {
  const draft = item.metadata?.scheduled_task_draft;
  if (!isPlainRecord(draft) || draft.should_create === false) return null;
  if (typeof draft.title !== 'string' || typeof draft.prompt !== 'string' || typeof draft.agent_id !== 'string') {
    return null;
  }
  return draft as unknown as ScheduledTaskDraftRead;
}

export function createdScheduledTaskForMessage(item: ChatMessage): ScheduledTaskRead | undefined {
  const task = item.metadata?.scheduled_task_created;
  if (!isPlainRecord(task)) return undefined;
  if (typeof task.id !== 'string' || typeof task.title !== 'string' || typeof task.prompt !== 'string') {
    return undefined;
  }
  return task as unknown as ScheduledTaskRead;
}

export function isScheduledTaskPrompt(item: ChatMessage): boolean {
  return item.role === 'user' && item.metadata?.interaction_mode === 'scheduled_task';
}

/** 将引用类型枚举映射为当前语言标签；引用标题和来源本身保持 raw。 */
export function citationKindLabel(citation: KnowledgeCitation, translate: ChatTranslate): string {
  if (citation.kind === 'concept' || citation.kind === 'okf') return translate('chat.dialog.knowledgeGraph');
  return translate('chat.dialog.citationExcerpt');
}

/** 提取引用业务标题；缺失值交给调用组件显示本地化 fallback。 */
export function citationDisplayTitle(citation: KnowledgeCitation): string {
  const raw = citation.title || citation.section_path || citation.source_path || citation.concept_id || '';
  return raw.trim();
}

/** 提取引用来源路径原文，不把路径当作需要翻译的产品文案。 */
export function citationSourceLabel(citation: KnowledgeCitation): string {
  const raw = citation.source_path || '';
  if (!raw) return '';
  return raw.trim();
}

export function citationSectionLabel(citation: KnowledgeCitation): string {
  const raw = citation.section_path || citation.title || '';
  return raw.trim();
}

// ---------------------------------------------------------------------------
// Clipboard / pasted image helpers
// ---------------------------------------------------------------------------
const MAX_PASTED_REMOTE_IMAGES = 6;

type ClipboardImageItem = {
  types: readonly string[];
  getType: (type: string) => Promise<Blob>;
};

export function clipboardContainsComposerImage(clipboardData: DataTransfer): boolean {
  if (Array.from(clipboardData.files || []).some((file) => file.type.startsWith('image/'))) {
    return true;
  }
  if (Array.from(clipboardData.items || []).some((item) => item.kind === 'file' && item.type.startsWith('image/'))) {
    return true;
  }
  return extractImageSourceUrls(clipboardData.getData('text/html')).length > 0
    || extractImageSourceUrls(clipboardData.getData('text/plain')).length > 0;
}

export async function extractPastedComposerFiles(clipboardData: DataTransfer): Promise<File[]> {
  const files = extractPastedComposerFilesSync(clipboardData);
  const seen = new Set(files.map(pastedFileKey));

  const pushFile = (file: File | null | undefined) => {
    if (!file || file.size <= 0) return;
    const key = pastedFileKey(file);
    if (seen.has(key)) return;
    seen.add(key);
    files.push(file);
  };

  const imageSources = [
    ...extractImageSourceUrls(clipboardData.getData('text/html')),
    ...extractImageSourceUrls(clipboardData.getData('text/plain')),
  ].filter((source) => !isImageDataUrl(source));

  for (const [index, source] of imageSources.slice(0, MAX_PASTED_REMOTE_IMAGES).entries()) {
    pushFile(await imageSourceToFile(source, files.length + index));
  }

  if (files.length === 0) {
    const clipboardImages = await readClipboardImageItems();
    clipboardImages.forEach((file) => pushFile(file));
  }

  return files;
}

function extractPastedComposerFilesSync(clipboardData: DataTransfer): File[] {
  const files: File[] = [];
  const seen = new Set<string>();

  const pushFile = (file: File | null | undefined, index: number) => {
    if (!file || file.size <= 0) return;
    const normalized = normalizePastedFile(file, index);
    const key = pastedFileKey(normalized);
    if (seen.has(key)) return;
    seen.add(key);
    files.push(normalized);
  };

  Array.from(clipboardData.files || []).forEach((file, index) => pushFile(file, index));

  Array.from(clipboardData.items || []).forEach((item, index) => {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) return;
    pushFile(item.getAsFile(), files.length + index);
  });

  const dataUrls = [
    ...extractImageDataUrls(clipboardData.getData('text/html')),
    ...extractImageDataUrls(clipboardData.getData('text/plain')),
  ];
  dataUrls.forEach((dataUrl, index) => pushFile(dataUrlToImageFile(dataUrl, index), files.length + index));

  return files;
}

function normalizePastedFile(file: File, index: number): File {
  const type = file.type || 'application/octet-stream';
  const hasUsefulName = Boolean(file.name && !/^image\.(png|jpe?g|gif|webp)$/i.test(file.name));
  if (hasUsefulName) return file;

  const filename = type.startsWith('image/')
    ? `pasted-image-${Date.now()}-${index + 1}.${imageExtension(type)}`
    : (file.name || `pasted-file-${Date.now()}-${index + 1}`);
  return new File([file], filename, { type, lastModified: file.lastModified || Date.now() });
}

function pastedFileKey(file: File): string {
  return `${file.type || 'application/octet-stream'}:${file.size}`;
}

function extractImageDataUrls(raw: string): string[] {
  return extractImageSourceUrls(raw).filter(isImageDataUrl);
}

function extractImageSourceUrls(raw: string): string[] {
  if (!raw) return [];
  const urls = new Set<string>();
  const text = raw.trim();
  if (isImageDataUrl(text) || isLikelyImageUrl(text)) {
    urls.add(text);
  }

  try {
    const document = new DOMParser().parseFromString(raw, 'text/html');
    Array.from(document.images).forEach((image) => {
      const src = image.getAttribute('src') || '';
      if (isSupportedPastedImageSource(src, true)) urls.add(src.trim());
    });
  } catch {
    // DOMParser is best-effort here; the regex below still catches inline image data.
  }

  const matches = raw.match(/data:image\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^,;]*)*;base64,[a-z0-9+/=\r\n]+/gi) || [];
  matches.forEach((url) => {
    if (isImageDataUrl(url)) urls.add(url);
  });
  const urlMatches = raw.match(/https?:\/\/[^\s"'<>]+/gi) || [];
  urlMatches.forEach((url) => {
    if (isLikelyImageUrl(url)) urls.add(url);
  });
  return Array.from(urls);
}

function isImageDataUrl(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+(?:;[^,]*)?,/i.test(value.trim());
}

function isSupportedPastedImageSource(value: string, fromImageElement = false): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isImageDataUrl(trimmed)) return true;
  if (trimmed.startsWith('blob:')) return true;
  if (/^https?:\/\//i.test(trimmed)) return fromImageElement || isLikelyImageUrl(trimmed);
  if (trimmed.startsWith('//')) return fromImageElement || isLikelyImageUrl(`https:${trimmed}`);
  return false;
}

function isLikelyImageUrl(value: string): boolean {
  return /^https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|gif|webp|bmp|svg|heic|tiff?)(?:[?#][^\s"'<>]*)?$/i.test(value.trim());
}

async function imageSourceToFile(source: string, index: number): Promise<File | null> {
  const normalized = normalizePastedImageSource(source);
  if (!normalized) return null;
  if (isImageDataUrl(normalized)) {
    return dataUrlToImageFile(normalized, index);
  }
  try {
    const response = await fetch(normalized);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) return null;
    return blobToPastedImageFile(blob, index, pastedImageNameFromUrl(normalized));
  } catch {
    return null;
  }
}

function normalizePastedImageSource(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) return null;
  if (isImageDataUrl(trimmed) || trimmed.startsWith('blob:') || /^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('//')) return `${window.location.protocol}${trimmed}`;
  return null;
}

function pastedImageNameFromUrl(source: string): string | undefined {
  try {
    const pathname = new URL(source, window.location.href).pathname;
    const name = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
    return isLikelyImageFilename(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

function isLikelyImageFilename(value: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|bmp|svg|heic|tiff?)$/i.test(value);
}

async function readClipboardImageItems(): Promise<File[]> {
  const clipboard = navigator.clipboard as (Clipboard & { read?: () => Promise<ClipboardImageItem[]> }) | undefined;
  if (!clipboard?.read) return [];
  try {
    const items = await clipboard.read();
    const files: File[] = [];
    for (const [index, item] of items.entries()) {
      const imageType = item.types.find((type) => type.startsWith('image/'));
      if (!imageType) continue;
      const blob = await item.getType(imageType);
      files.push(blobToPastedImageFile(blob, index));
    }
    return files;
  } catch {
    return [];
  }
}

function dataUrlToImageFile(dataUrl: string, index: number): File | null {
  const match = dataUrl.trim().match(/^data:(image\/[a-z0-9.+-]+)((?:;[^,]*)?),(.*)$/i);
  if (!match) return null;
  const type = match[1] || 'image/png';
  const meta = match[2] || '';
  const payload = match[3] || '';

  try {
    const bytes = meta.toLowerCase().includes(';base64')
      ? bytesFromBase64(payload)
      : new TextEncoder().encode(decodeURIComponent(payload));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new File([buffer], `pasted-image-${Date.now()}-${index + 1}.${imageExtension(type)}`, { type });
  } catch {
    return null;
  }
}

function blobToPastedImageFile(blob: Blob, index: number, filename?: string): File {
  const type = blob.type || 'image/png';
  return new File([blob], filename || `pasted-image-${Date.now()}-${index + 1}.${imageExtension(type)}`, {
    type,
    lastModified: Date.now(),
  });
}

function bytesFromBase64(payload: string): Uint8Array {
  const binary = window.atob(payload.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function imageExtension(contentType: string): string {
  const normalized = contentType.toLowerCase().split(';')[0];
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/bmp') return 'bmp';
  if (normalized === 'image/svg+xml') return 'svg';
  if (normalized === 'image/heic') return 'heic';
  if (normalized === 'image/tiff') return 'tiff';
  return 'png';
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------
export function toRequestAttachment(attachment: ComposerAttachment): ChatAttachmentRead {
  const { uploadStatus: _uploadStatus, uploadKey: _uploadKey, ...rest } = attachment;
  return rest;
}

export function messageAttachments(messageItem: ChatMessage): ChatAttachmentRead[] {
  const attachments = messageItem.metadata?.attachments;
  if (!Array.isArray(attachments)) return [];
  return attachments.filter(isChatAttachment);
}

export function harnessWorkspaceArtifacts(
  messageItem: ChatMessage,
): HarnessWorkspaceArtifact[] {
  const artifacts = messageItem.metadata?.harness_artifacts;
  if (!Array.isArray(artifacts)) return [];
  const seen = new Set<string>();
  const result: HarnessWorkspaceArtifact[] = [];
  artifacts.forEach((value) => {
    if (!value || typeof value !== 'object') return;
    const artifact = value as Partial<HarnessWorkspaceArtifact>;
    if (
      artifact.type !== 'workspace_file'
      || typeof artifact.task_frame_id !== 'string'
      || !artifact.task_frame_id.trim()
      || typeof artifact.path !== 'string'
      || !artifact.path.trim()
    ) {
      return;
    }
    const identity = `${artifact.task_frame_id}\u001f${artifact.path}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    result.push({
      type: 'workspace_file',
      task_frame_id: artifact.task_frame_id,
      path: artifact.path,
      ...(typeof artifact.sandbox_path === 'string'
        ? { sandbox_path: artifact.sandbox_path }
        : {}),
      ...(typeof artifact.sha256 === 'string' ? { sha256: artifact.sha256 } : {}),
      ...(typeof artifact.size === 'number' && Number.isFinite(artifact.size)
        ? { size: artifact.size }
        : {}),
      ...(typeof artifact.display_name === 'string'
        ? { display_name: artifact.display_name }
        : {}),
      ...(typeof artifact.description === 'string'
        ? { description: artifact.description }
        : {}),
      ...(typeof artifact.content_type === 'string'
        ? { content_type: artifact.content_type }
        : {}),
      ...(typeof artifact.operation === 'string'
        ? { operation: artifact.operation }
        : {}),
      ...(typeof artifact.source === 'string'
        ? { source: artifact.source }
        : {}),
    });
  });
  return result;
}

function isChatAttachment(value: unknown): value is ChatAttachmentRead {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<ChatAttachmentRead>;
  return typeof item.id === 'string' && typeof item.filename === 'string';
}

/** 生成附件类型与大小摘要；类型标签本地化，文件名和错误详情由组件保持 raw。 */
export function attachmentTypeLabel(
  attachment: ChatAttachmentRead,
  locale: AppLocale,
  translate: ChatTranslate,
): string {
  const size = formatAttachmentSize(attachment.size, locale);
  const type = attachment.kind === 'pdf'
    ? translate('chat.attachment.pdf')
    : attachment.kind === 'image'
      ? translate('chat.attachment.image')
      : attachment.kind === 'text'
        ? translate('chat.attachment.text')
        : translate('chat.attachment.file');
  return `${type}${size ? ` · ${size}` : ''}`;
}

/** 使用当前 locale 的 Intl 单位格式化附件大小，避免固定英文或中文地区参数。 */
function formatAttachmentSize(size: number, locale: AppLocale): string {
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024) {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'byte',
      unitDisplay: 'short',
      maximumFractionDigits: 0,
    }).format(size);
  }
  if (size < 1024 * 1024) {
    return new Intl.NumberFormat(locale, {
      style: 'unit',
      unit: 'kilobyte',
      unitDisplay: 'short',
      maximumFractionDigits: size < 10 * 1024 ? 1 : 0,
    }).format(size / 1024);
  }
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit: 'megabyte',
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(size / 1024 / 1024);
}

// ---------------------------------------------------------------------------
// Scheduled task draft schedule helpers
// ---------------------------------------------------------------------------
/** 将排程结构格式化为当前语言摘要；时间按显式 locale/timezone 输出，输入字段保持 raw。 */
export function formatDraftSchedule(
  draft: ScheduledTaskDraftRead,
  locale: AppLocale,
  translate: ChatTranslate,
  timeZone = getClientTimeZone(),
): string {
  const formatters = createFormatters(locale);
  const schedule = draft.schedule || {};
  const scheduleType = normalizeDraftScheduleType(draft.schedule_type);
  if (scheduleType === 'weekly') {
    const weekdays = Array.isArray(schedule.weekdays)
      ? schedule.weekdays
        .map((item) => DRAFT_WEEKDAY_MESSAGE_IDS[Number(item)])
        .filter((id) => Boolean(id))
        .map((id) => translate(id))
      : [translate('chat.draft.weekday.monday')];
    return translate('chat.draft.weeklySchedule', {
      weekdays: formatters.formatList(weekdays, { type: 'conjunction' }),
      time: String(schedule.time || translate('chat.draft.pendingTime')),
    });
  }
  if (scheduleType === 'monthly') {
    return translate('chat.draft.monthlySchedule', {
      day: String(schedule.day_of_month || 1),
      time: String(schedule.time || translate('chat.draft.pendingTime')),
    });
  }
  if (scheduleType === 'once') {
    const value = String(schedule.run_at || '');
    if (!value) return translate('chat.draft.once');
    const parsed = parseBackendDateTime(value);
    const formatted = Number.isNaN(parsed.getTime())
      ? value
      : formatters.formatDate(parsed, { dateStyle: 'medium', timeStyle: 'short', timeZone });
    return translate('chat.draft.onceSchedule', { runAt: formatted });
  }
  return translate('chat.draft.dailySchedule', {
    time: String(schedule.time || translate('chat.draft.pendingTime')),
  });
}

/** 将排程类型协议枚举映射为语义消息，不把枚举值直接当用户文案。 */
export function scheduleTypeLabel(
  type: ScheduledTaskDraftRead['schedule_type'],
  translate: ChatTranslate,
): string {
  switch (normalizeDraftScheduleType(type)) {
    case 'once':
      return translate('chat.draft.once');
    case 'weekly':
      return translate('chat.draft.weekly');
    case 'monthly':
      return translate('chat.draft.monthly');
    default:
      return translate('chat.draft.daily');
  }
}

export function scheduleEditValue(draft: ScheduledTaskDraftRead): string {
  const schedule = draft.schedule || {};
  if (normalizeDraftScheduleType(draft.schedule_type) === 'once') return String(schedule.run_at || '');
  return String(schedule.time || '09:00');
}

export function scheduleFromEditValue(draft: ScheduledTaskDraftRead, value: string): Record<string, unknown> {
  if (normalizeDraftScheduleType(draft.schedule_type) === 'once') {
    return { ...(draft.schedule || {}), run_at: value };
  }
  return { ...(draft.schedule || {}), time: value };
}

export function draftScheduleForType(schedule: Record<string, unknown>, type: DraftScheduleType): Record<string, unknown> {
  const time = String(schedule.time || '09:00');
  if (type === 'once') {
    return { run_at: String(schedule.run_at || '') };
  }
  if (type === 'weekly') {
    return {
      time,
      weekdays: Array.isArray(schedule.weekdays) ? schedule.weekdays : [0],
    };
  }
  if (type === 'monthly') {
    return {
      time,
      day_of_month: schedule.day_of_month || 1,
    };
  }
  return { time };
}

export function normalizeDraftScheduleType(value: string): DraftScheduleType {
  const scheduleType = value as DraftScheduleType;
  return DRAFT_SCHEDULE_TYPES.has(scheduleType) ? scheduleType : 'daily';
}
