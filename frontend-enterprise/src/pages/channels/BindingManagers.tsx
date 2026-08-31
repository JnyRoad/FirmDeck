import { useEffect, useState } from 'react';

import { createToastNotifier } from '@/components/ui/app-toast';
import { Button as UIButton } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';
import { createMessageDescriptor, type MessageDescriptor } from '@/i18n/descriptors';
import { useAppIntl } from '@/i18n/useAppIntl';
import type { MessageId } from '@/i18n/types';
import { backendErrorMessageDescriptor } from '@/lib/apiErrorMessages';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';

import { api, TENANT_ID } from '../../api/client';
import type { ChannelBindingManagerRead } from '../../types';

type TenantUser = {
  id: string;
  username: string;
  display_name?: string;
  source?: string;
};

type Props = {
  bindingId: string;
  users: TenantUser[];
  creatorUserId?: string | null;
};

/** 将稳定后端错误投影为当前页面可安全展示的 descriptor，拒绝 raw detail 透传。 */
function errorDescriptor(error: unknown, fallbackId: MessageId): MessageDescriptor {
  const descriptor = backendErrorMessageDescriptor(error);
  return descriptor
    ? { id: descriptor.messageId, values: descriptor.values }
    : createMessageDescriptor(fallbackId);
}

/** 渲染渠道协作者管理区域；成员名称与用户标识保持 raw，产品 chrome 跟随当前 UI locale。 */
export default function BindingManagers({ bindingId, users, creatorUserId }: Props) {
  const { t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const [managers, setManagers] = useState<ChannelBindingManagerRead[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [candidate, setCandidate] = useState('');

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bindingId]);

  /** 加载协作者列表；错误只通过稳定错误契约或安全 fallback 进入产品 Toast。 */
  async function load() {
    setLoading(true);
    try {
      const data = await api.get<ChannelBindingManagerRead[]>(
        `/api/enterprise/channels/${bindingId}/managers?tenant_id=${TENANT_ID}`,
      );
      setManagers(data);
    } catch (error) {
      toast.error(errorDescriptor(error, 'channels.collaborators.loadFailed'));
    } finally {
      setLoading(false);
    }
  }

  const existingIds = new Set(managers.map((m) => m.user_id));
  const candidates = users.filter(
    (u) => (!u.source || u.source === 'web') && u.id !== creatorUserId && !existingIds.has(u.id),
  );

  /** 添加当前租户内部协作者并刷新列表，用户输入仅作为 API 标识传递。 */
  async function add() {
    if (!candidate) return;
    setAdding(true);
    try {
      await api.post(`/api/enterprise/channels/${bindingId}/managers?tenant_id=${TENANT_ID}`, {
        user_id: candidate,
      });
      setCandidate('');
      await load();
      toast.success(createMessageDescriptor('channels.collaborators.added'));
    } catch (error) {
      toast.error(errorDescriptor(error, 'channels.collaborators.addFailed'));
    } finally {
      setAdding(false);
    }
  }

  /** 移除指定协作者；userId 是 raw 标识，不参与产品文案翻译。 */
  async function remove(userId: string) {
    try {
      await api.delete(
        `/api/enterprise/channels/${bindingId}/managers/${userId}?tenant_id=${TENANT_ID}`,
      );
      await load();
      toast.success(createMessageDescriptor('channels.collaborators.removed'));
    } catch (error) {
      toast.error(errorDescriptor(error, 'channels.collaborators.removeFailed'));
    }
  }

  return (
    <div className="flex flex-col gap-[12px] border-t border-[#eef0f4] pt-[16px]">
      <div className="flex min-w-0 flex-col gap-[4px]">
        <span className="text-[13px] font-semibold text-[#18181a]">{t('channels.collaborators.title')}</span>
        <span className="text-[12px] leading-[1.6] text-[#858b9c]">
          {t('channels.collaborators.description')}
        </span>
      </div>
      {loading ? (
        <span className="text-[12px] text-[#858b9c]">{t('channels.state.loading')}</span>
      ) : managers.length === 0 ? (
        <span className="text-[12px] text-[#858b9c]">{t('channels.collaborators.empty')}</span>
      ) : (
        <ul className="flex flex-col gap-[8px]">
          {managers.map((m) => (
            <li key={m.user_id} className="flex items-center justify-between gap-[12px]">
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[12px] text-[#18181a]">
                  {m.name ? <RawContent value={m.name} /> : <RawIdentifier value={m.user_id} />}
                </span>
                <span className="text-[11px] text-[#858b9c]">
                  {t('channels.collaborators.grantedBy')}{' '}
                  {m.granted_by_name ? <RawContent value={m.granted_by_name} /> : m.granted_by_user_id ? <RawIdentifier value={m.granted_by_user_id} /> : t('channels.placeholder.none')}
                </span>
              </div>
              <UIButton
                variant="outline"
                className="h-7 rounded-[8px] border-[#e3e7f1] px-3 text-[11px] text-[#464c5e] hover:bg-[#f6f6f6]"
                onClick={() => void remove(m.user_id)}
              >
                {t('channels.action.remove')}
              </UIButton>
            </li>
          ))}
        </ul>
      )}
      {candidates.length > 0 ? (
        <div className="flex items-center gap-[8px]">
          <Select value={candidate || '__none__'} onValueChange={(v) => setCandidate(v === '__none__' ? '' : v)}>
            <SelectTrigger className="h-[32px] w-[180px] text-[12px]">
              <SelectValue placeholder={t('channels.collaborators.selectMember')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t('channels.collaborators.noneSelected')}</SelectItem>
              {candidates.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.display_name || u.username ? <RawContent value={u.display_name || u.username} /> : <RawIdentifier value={u.id} />}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <UIButton
            variant="outline"
            className="h-8 rounded-[8px] border-[#e3e7f1] px-4 text-[12px] text-[#464c5e] hover:bg-[#f6f6f6]"
            disabled={adding || !candidate}
            onClick={() => void add()}
          >
            {t('channels.action.add')}
          </UIButton>
        </div>
      ) : (
        <span className="text-[11px] text-[#858b9c]">{t('channels.collaborators.noCandidates')}</span>
      )}
    </div>
  );
}
