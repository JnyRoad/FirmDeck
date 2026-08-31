import type { ChatAttachmentRead } from '@/types';
import {
  createLegacyLanguageContextSnapshot,
  parseLanguageContextSnapshot,
  type LanguageContextSnapshot,
} from '@/i18n/languagePreferences';

import type { ComposerInteractionMode } from './chatTypes';

const CHAT_QUEUE_STORAGE_PREFIX = 'skill_agent_chat_queue';
const INTERACTION_MODES = new Set<ComposerInteractionMode>(['normal', 'scheduled_task']);

type ChatQueueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type PreparedChatTurn = {
  queueId: string;
  conversationId: string;
  agentId: string;
  turnId: string;
  text: string;
  attachments: ChatAttachmentRead[];
  interactionMode: ComposerInteractionMode;
  modelConfigId?: string;
  createdAt: string;
  languageContext: LanguageContextSnapshot;
};

/** 判断未知值是否为可安全继续结构校验的普通对象；无副作用。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** 校验队列附件的持久化最小字段；失败只拒绝所属 turn，不修改附件内容。 */
function isQueuedAttachment(value: unknown): value is ChatAttachmentRead {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string'
    && typeof value.filename === 'string'
    && typeof value.content_type === 'string'
    && typeof value.size === 'number'
    && ['text', 'pdf', 'image', 'binary'].includes(String(value.kind || ''))
  );
}

/**
 * 将持久化队列项恢复为规范 turn；旧项确定性补中文快照，显式但损坏的快照则拒绝恢复。
 */
function parsePreparedChatTurn(value: unknown): PreparedChatTurn | null {
  if (!isRecord(value)) return null;
  const hasValidBaseShape = (
    typeof value.queueId === 'string'
    && typeof value.conversationId === 'string'
    && typeof value.agentId === 'string'
    && typeof value.turnId === 'string'
    && typeof value.text === 'string'
    && Array.isArray(value.attachments)
    && value.attachments.every(isQueuedAttachment)
    && typeof value.interactionMode === 'string'
    && INTERACTION_MODES.has(value.interactionMode as ComposerInteractionMode)
    && (value.modelConfigId === undefined || typeof value.modelConfigId === 'string')
    && typeof value.createdAt === 'string'
    && Number.isFinite(Date.parse(value.createdAt))
  );
  if (!hasValidBaseShape) return null;

  const languageContext = value.languageContext === undefined
    ? createLegacyLanguageContextSnapshot()
    : parseLanguageContextSnapshot(value.languageContext);
  if (!languageContext) return null;

  return {
    queueId: value.queueId as string,
    conversationId: value.conversationId as string,
    agentId: value.agentId as string,
    turnId: value.turnId as string,
    text: value.text as string,
    attachments: value.attachments as ChatAttachmentRead[],
    interactionMode: value.interactionMode as ComposerInteractionMode,
    ...(typeof value.modelConfigId === 'string' ? { modelConfigId: value.modelConfigId } : {}),
    createdAt: value.createdAt as string,
    languageContext,
  };
}

/** 生成租户和用户隔离的会话队列键；空标识使用固定兼容命名空间。 */
export function chatQueueStorageKey(tenantId: string, userId: string): string {
  return `${CHAT_QUEUE_STORAGE_PREFIX}:${tenantId || 'default'}:${userId || 'anonymous'}`;
}

/**
 * 读取、校验并去重持久化 turn；损坏项被移除，旧项补齐语言快照后立即回写，存储异常时清空。
 */
export function readQueuedChatTurns(storage: ChatQueueStorage, key: string): PreparedChatTurn[] {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error('Invalid chat queue payload');

    const seen = new Set<string>();
    const turns: PreparedChatTurn[] = [];
    let requiresRewrite = false;
    for (const value of parsed) {
      const turn = parsePreparedChatTurn(value);
      if (!turn) {
        requiresRewrite = true;
        continue;
      }
      const identity = `${turn.queueId}:${turn.turnId}`;
      if (seen.has(identity)) {
        requiresRewrite = true;
        continue;
      }
      seen.add(identity);
      if (isRecord(value) && value.languageContext === undefined) requiresRewrite = true;
      turns.push(turn);
    }
    if (requiresRewrite || turns.length !== parsed.length) {
      writeQueuedChatTurns(storage, key, turns);
    }
    return turns;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Storage access can be blocked by the browser privacy policy.
    }
    return [];
  }
}

/** 保存当前规范队列，空队列删除键；浏览器拒绝写入时清理残留并返回 false。 */
export function writeQueuedChatTurns(
  storage: ChatQueueStorage,
  key: string,
  turns: PreparedChatTurn[],
): boolean {
  try {
    if (turns.length === 0) {
      storage.removeItem(key);
    } else {
      storage.setItem(key, JSON.stringify(turns));
    }
    return true;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Storage cleanup is best-effort when the browser quota is unavailable.
    }
    return false;
  }
}
