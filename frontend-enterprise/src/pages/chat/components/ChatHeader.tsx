import { useEffect, useMemo, useState, type ChangeEvent } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui';
import { createTenantClient } from '@/api/tenant-client';
import { useTenantSession } from '@/contexts/TenantSessionContext';
import { firmdeckDisplayText } from '@/employee';
import type { TeamRead } from '@/types';
import IconEdit from '@/assets/icons/edit.svg?react';
import IconChevronDown from '@/assets/icons/chevron-down.svg?react';
import IconLogout from '@/assets/icons/logout.svg?react';
import LanguageSwitcher from '@/components/LanguageSwitcher';
import { RawIdentifier } from '@/i18n/RawContent';
import { DEFAULT_LOCALE, type AppLocale } from '@/i18n/locales';
import { useAppIntl } from '@/i18n/useAppIntl';

import {
  CHAT_HEADER_CLASS,
  CHAT_HEADER_TITLE_NAME_CLASS,
  CHAT_HEADER_TITLE_STACK_CLASS,
} from '../chatPageStyles';
import type { UseChatSession } from '../useChatSession';

/** 渲染聊天标题栏；产品 chrome 使用语义消息，会话/团队名称保持原始业务标识。 */
export default function ChatHeader({ chat }: { chat: UseChatSession }) {
  const { auth, currentSession, openRename, logout } = chat;
  const { t } = useAppIntl();
  const tenantContext = useTenantSession();
  const tenantClient = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const teamId = currentSession?.team_id || null;
  const rawName = currentSession?.title
    ? firmdeckDisplayText(currentSession.title)
    : currentSession?.id || t('chat.header.newConversation');
  const username = auth?.user?.username || '';
  const initial = username ? username.slice(0, 1).toUpperCase() : '--';
  const replyLocale = chat.agentReplyLocale || DEFAULT_LOCALE;

  /** 将控件选择写入新会话偏好；锁定的既有 session 由 disabled 状态阻止修改。 */
  const handleReplyLocaleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    chat.setAgentReplyLocale?.(event.target.value as AppLocale);
  };

  // 团队会话徽标：read 带 team_name 直接用；缺省时用团队列表做 id→name 映射。
  const sessionTeamName = currentSession?.team_name || null;
  const [teamName, setTeamName] = useState<string | null>(sessionTeamName);
  const name = teamId
    ? teamName || rawName.replace(/^团队\s*/, '').replace(/\s*·\s*TL 对话$/, '')
    : rawName;

  useEffect(() => {
    setTeamName(sessionTeamName);
    if (!teamId || sessionTeamName || !tenantContext) return;
    let cancelled = false;
    const controller = new AbortController();
    const onTenantAbort = () => controller.abort();
    tenantContext.signal.addEventListener('abort', onTenantAbort, { once: true });
    tenantClient.get<TeamRead[]>('/api/enterprise/teams', { signal: controller.signal })
      .then((rows) => {
        if (!cancelled && !controller.signal.aborted) setTeamName(rows.find((team) => team.id === teamId)?.name || null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      tenantContext.signal.removeEventListener('abort', onTenantAbort);
      controller.abort();
    };
  }, [teamId, sessionTeamName, tenantClient, tenantContext]);

  return (
    <div className={CHAT_HEADER_CLASS}>
      <div className={CHAT_HEADER_TITLE_STACK_CLASS}>
        <span className="flex min-w-0 items-center gap-[4px]">
          <span className={CHAT_HEADER_TITLE_NAME_CLASS} title={name}>
            <RawIdentifier value={name} />
          </span>
          {teamId && (
            <Badge
              variant="secondary"
              className="shrink-0 rounded-full bg-[#e8f0ff] text-[12px] font-normal text-[#1a71ff]"
            >
              {t('chat.header.groupChat')}
            </Badge>
          )}
          {currentSession && !teamId && (
            <button
              type="button"
              aria-label={t('chat.header.rename')}
              onClick={() => openRename(currentSession)}
              className="inline-grid size-[14px] shrink-0 place-items-center text-[#858b9c] transition-colors hover:text-[#18181a]"
            >
              <IconEdit className="size-[14px]!" />
            </button>
          )}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-[8px]">
        <select
          aria-label={t('chat.header.replyLanguage')}
          title={chat.agentReplyLocaleLocked
            ? t('chat.header.replyLanguageLocked')
            : t('chat.header.replyLanguage')}
          value={replyLocale}
          disabled={chat.agentReplyLocaleLocked}
          onChange={handleReplyLocaleChange}
          className="h-[32px] shrink-0 rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-white px-[8px] text-[12px] font-medium text-[#757f9c] outline-none transition-colors hover:border-[#cbd3e6] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value="zh-CN">{t('chat.header.replyLanguageChinese')}</option>
          <option value="en-US">{t('chat.header.replyLanguageEnglish')}</option>
        </select>
        <LanguageSwitcher />
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t('chat.header.accountMenu')}
            className="flex shrink-0 items-center gap-[10px] rounded-[10px] py-[4px] pl-[6px] pr-[10px] outline-none transition-colors"
          >
            <span className="grid size-[32px] shrink-0 place-items-center overflow-hidden rounded-full bg-[#eef1fb] text-[14px] font-medium text-[#7e96dc]">
              {initial}
            </span>
            <IconChevronDown className="size-[14px] shrink-0 text-[#757F9C]" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="w-fit min-w-[160px] rounded-[14px] border-0 bg-white p-[6px] shadow-[0px_16px_15px_rgba(0,0,0,0.1)] ring-0 [--accent:#F6F6F6] [--accent-foreground:#18181A]"
          >
            <DropdownMenuItem
              onSelect={logout}
              className="h-[36px] cursor-pointer gap-2 rounded-[10px] px-[12px] text-[14px] text-[#464C5E]"
            >
              <IconLogout className="size-[16px]" />
              {t('shell.account.logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
