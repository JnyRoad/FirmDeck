import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api, TENANT_ID } from '../api/client';
import { EnterpriseRoute } from '../enums/routes';
import { apiErrorMessage } from '../lib/apiErrorMessages';
import { useAppIntl, type AppTranslator, type MessageId, type MessageValues } from '@/i18n';

type TeamChatMessageId = MessageId;

/** 将组件内 translator 扩展为待补目录键的类型化适配器；不读取或改写原始团队数据。 */
function translateTeamChat(
  translator: Pick<AppTranslator, 't'>,
  id: TeamChatMessageId,
  values?: MessageValues,
): string {
  return translator.t(id, values);
}

/** 为团队群聊入口安全解析错误；未知错误只返回受控本地化 fallback。 */
function teamChatErrorMessage(
  error: unknown,
  fallbackId: TeamChatMessageId,
  translator: Pick<AppTranslator, 't'>,
): string {
  const fallback = translateTeamChat(translator, fallbackId);
  const message = apiErrorMessage(error, fallbackId, translator);
  return message === translator.t('common.error.generic') ? fallback : message;
}

/** 打开团队唯一持久群聊；失败时展示本地化产品状态且不透传异常正文。 */
export default function TeamChatPage() {
  const { teamId = '' } = useParams<{ teamId: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const { t: appT } = useAppIntl();

  useEffect(() => {
    let cancelled = false;
    if (!teamId) {
      setError(translateTeamChat({ t: appT }, 'teamChatPage.error.teamNotFound'));
      return undefined;
    }
    api
      .post<{ session_id: string }>(`/api/enterprise/teams/${teamId}/tl/session`, {
        tenant_id: TENANT_ID,
      })
      .then((result) => {
        if (cancelled) return;
        if (!result.session_id) throw new Error('TEAM_SESSION_MISSING');
        navigate(`${EnterpriseRoute.Chat}/${result.session_id}`, { replace: true });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(teamChatErrorMessage(reason, 'teamChatPage.error.openFailed', { t: appT }));
      });
    return () => {
      cancelled = true;
    };
  }, [appT, navigate, teamId]);

  return (
    <div className="grid min-h-[60vh] place-items-center px-[24px] text-center">
      <p className="text-[14px] text-[#646b7c]">
        {error || translateTeamChat({ t: appT }, 'teamChatPage.loading')}
      </p>
    </div>
  );
}
