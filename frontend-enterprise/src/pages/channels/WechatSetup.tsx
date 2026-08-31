import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { createToastNotifier } from '@/components/ui/app-toast';

import { Input } from '@/components/ui';
import { Button as UIButton } from '@/components/ui/button';
import { createMessageDescriptor, type MessageDescriptor } from '@/i18n/descriptors';
import { useAppIntl } from '@/i18n/useAppIntl';
import type { MessageId } from '@/i18n/types';
import { backendErrorMessageDescriptor } from '@/lib/apiErrorMessages';

import { api, TENANT_ID } from '../../api/client';
import type { ChannelBindingRead } from '../../types';
import { StatusBadge } from '../scheduled-tasks/StatusBadge';

type WechatQrcodeResponse = {
  qrcode?: string;
  qrcode_img_content?: string;
  qrcode_img_url?: string;
};

type WechatQrcodeStatusResponse = {
  status?: string;
};

type QrState = {
  qrcode: string;
  content: string;
  imageUrl: string;
};

const PRIMARY_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] bg-[#18181a] px-5 text-[12px] font-normal text-white hover:bg-[#303030]';
const OUTLINE_BUTTON_CLASS =
  'h-8 gap-1 rounded-[10px] border-[#e3e7f1] px-5 text-[12px] font-normal text-[#464c5e] hover:bg-[#f6f6f6] hover:text-[#18181a]';

/** 将稳定后端错误投影为当前二维码流程可展示的 descriptor，禁止 raw detail 透传。 */
function errorDescriptor(error: unknown, fallbackId: MessageId): MessageDescriptor {
  const descriptor = backendErrorMessageDescriptor(error);
  return descriptor
    ? { id: descriptor.messageId, values: descriptor.values }
    : createMessageDescriptor(fallbackId);
}

/** 渲染微信二维码绑定区域；二维码 payload 与验证码保持 raw，状态 chrome 使用语义消息。 */
export default function WechatSetup({
  binding,
  onChanged,
}: {
  binding: ChannelBindingRead;
  onChanged: () => void;
}) {
  const { t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const [qr, setQr] = useState<QrState | null>(null);
  const [qrStatus, setQrStatus] = useState('');
  const [qrLoading, setQrLoading] = useState(false);
  const [verifyCode, setVerifyCode] = useState('');
  const qrSessionRef = useRef(0);
  const pollTimerRef = useRef<number | null>(null);
  const verifyCodeRef = useRef('');

  useEffect(() => {
    return () => {
      qrSessionRef.current += 1;
      clearPollTimer();
    };
  }, []);

  useEffect(() => {
    resetQrFlow();
  }, [binding.id]);

  /** 清理二维码状态轮询计时器，避免卸载或重新扫码后继续写入旧会话。 */
  function clearPollTimer() {
    if (pollTimerRef.current != null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }

  /** 重置二维码会话和验证码输入，不改变服务端原始二维码内容。 */
  function resetQrFlow() {
    qrSessionRef.current += 1;
    clearPollTimer();
    verifyCodeRef.current = '';
    setVerifyCode('');
    setQr(null);
    setQrStatus('');
  }

  /** 请求新的微信二维码并启动受控轮询；provider 返回值仅用于二维码 raw 数据。 */
  async function startQr(bindingId: string) {
    const session = ++qrSessionRef.current;
    clearPollTimer();
    verifyCodeRef.current = '';
    setVerifyCode('');
    setQrLoading(true);
    setQrStatus('');
    try {
      const result = await api.post<WechatQrcodeResponse>(
        `/api/enterprise/channels/${bindingId}/wechat/qrcode?tenant_id=${TENANT_ID}`,
      );
      const code = String(result.qrcode || '');
      const content = String(result.qrcode_img_content || result.qrcode_img_url || '');
      if (!code || !content) throw new Error('WECHAT_QR_CODE_EMPTY');
      const imageUrl = await QRCode.toDataURL(content, { width: 220, margin: 1 });
      if (session !== qrSessionRef.current) return;
      setQr({ qrcode: code, content, imageUrl });
      setQrStatus('wait');
      scheduleStatusPoll(bindingId, code, session);
    } catch (error) {
      if (session === qrSessionRef.current) {
        toast.error(errorDescriptor(error, 'channels.wechat.qrLoadFailed'));
      }
    } finally {
      if (session === qrSessionRef.current) setQrLoading(false);
    }
  }

  /** 调度下一次二维码状态查询，session token 保证旧请求不会污染新状态。 */
  function scheduleStatusPoll(bindingId: string, code: string, session: number) {
    clearPollTimer();
    pollTimerRef.current = window.setTimeout(() => {
      void pollQrStatus(bindingId, code, session);
    }, 2000);
  }

  /** 查询二维码确认状态并把有限状态映射为产品文案，保留 provider 状态码作为控制数据。 */
  async function pollQrStatus(bindingId: string, code: string, session: number) {
    try {
      const submittedCode = verifyCodeRef.current.trim();
      const verifyParam = submittedCode
        ? `&verify_code=${encodeURIComponent(submittedCode)}`
        : '';
      const result = await api.get<WechatQrcodeStatusResponse>(
        `/api/enterprise/channels/${bindingId}/wechat/qrcode-status?tenant_id=${TENANT_ID}&qrcode=${encodeURIComponent(code)}${verifyParam}`,
      );
      if (session !== qrSessionRef.current) return;
      const status = String(result.status || 'wait');
      if (status === 'confirmed') {
        resetQrFlow();
        toast.success(createMessageDescriptor('channels.wechat.connected'));
        onChanged();
        return;
      }
      if (status === 'binded_redirect') {
        resetQrFlow();
        toast.success(createMessageDescriptor('channels.wechat.reconnected'));
        onChanged();
        return;
      }
      if (status === 'expired' || status === 'verify_code_blocked') {
        setQrStatus(status);
        return;
      }
      setQrStatus(status);
      scheduleStatusPoll(bindingId, code, session);
    } catch (error) {
      if (session !== qrSessionRef.current) return;
      clearPollTimer();
      toast.error(errorDescriptor(error, 'channels.wechat.statusLoadFailed'));
    }
  }

  /** 提交用户输入的数字验证码；验证码保持 raw 输入并仅写入下一次 API 请求。 */
  function submitVerifyCode() {
    const code = verifyCode.trim();
    if (!code) return;
    verifyCodeRef.current = code;
  }

  const sessionExpired = Boolean(
    binding.session_expired ?? binding.config_json?.session_expired,
  );
  const trulyExpired = binding.status === 'expired';
  const recovering = sessionExpired && !trulyExpired;
  const showScanButton = !qr && (trulyExpired || binding.status === 'pending');
  const showRescanButton =
    !qr && !recovering && binding.status === 'active' && binding.connected;

  const qrHint =
    qrStatus === 'expired'
      ? t('channels.wechat.qr.expired')
      : qrStatus === 'verify_code_blocked'
        ? t('channels.wechat.qr.verifyBlocked')
        : qrStatus === 'need_verifycode'
          ? t('channels.wechat.qr.needVerifyCode')
          : qrStatus === 'scaned' || qrStatus === 'scaned_but_redirect'
            ? t('channels.wechat.qr.scanned')
            : t('channels.wechat.qr.instruction');

  return (
    <>
      {recovering && (
        <span className="flex items-center gap-[6px]">
          <StatusBadge tone="orange">{t('channels.status.recovering')}</StatusBadge>
          <span className="text-[12px] text-[#858b9c]">{t('channels.status.recoveringDescription')}</span>
        </span>
      )}
      {trulyExpired && (
        <span className="text-[12px] text-[#d20b0b]">{t('channels.wechat.sessionExpired')}</span>
      )}
      {showScanButton && (
        <div className="flex items-center gap-[8px]">
          <UIButton
            onClick={() => void startQr(binding.id)}
            disabled={qrLoading}
            className={PRIMARY_BUTTON_CLASS}
          >
            {qrLoading ? t('channels.wechat.qr.loading') : trulyExpired ? t('channels.wechat.qr.rescan') : t('channels.wechat.qr.connect')}
          </UIButton>
        </div>
      )}
      {showRescanButton && (
        <div className="flex items-center gap-[8px]">
          <UIButton
            variant="outline"
            onClick={() => void startQr(binding.id)}
            disabled={qrLoading}
            className={OUTLINE_BUTTON_CLASS}
          >
            {qrLoading ? t('channels.wechat.qr.loading') : t('channels.wechat.qr.rescan')}
          </UIButton>
        </div>
      )}
      {qr && (
        <div className="flex flex-col items-center gap-[10px] rounded-[10px] bg-[#fafbfc] p-[16px]">
          <img
            src={qr.imageUrl}
            alt={t('channels.wechat.qr.imageAlt')}
            className="size-[180px] rounded-[8px] border border-[#eef0f4]"
          />
          <span className="text-[12px] text-[#858b9c]">{qrHint}</span>
          {qrStatus === 'need_verifycode' && (
            <div className="flex items-center gap-[8px]">
              <Input
                value={verifyCode}
                onChange={(event) =>
                  setVerifyCode(event.target.value.replace(/\D/g, '').slice(0, 8))
                }
                placeholder={createMessageDescriptor('channels.wechat.qr.verifyCodePlaceholder')}
                inputMode="numeric"
                className="h-8 w-[140px] rounded-[10px] text-[12px]"
              />
              <UIButton
                onClick={submitVerifyCode}
                disabled={!verifyCode.trim()}
                className={PRIMARY_BUTTON_CLASS}
              >
                {t('common.action.confirm')}
              </UIButton>
            </div>
          )}
          {qrStatus === 'expired' || qrStatus === 'verify_code_blocked' ? (
            <UIButton
              onClick={() => void startQr(binding.id)}
              disabled={qrLoading}
              className={PRIMARY_BUTTON_CLASS}
            >
              {qrLoading
                ? t('channels.wechat.qr.loading')
                : qrStatus === 'expired'
                  ? t('channels.wechat.qr.refresh')
                  : t('channels.wechat.qr.rescan')}
            </UIButton>
          ) : (
            <UIButton variant="outline" onClick={resetQrFlow} className={OUTLINE_BUTTON_CLASS}>
              {t('common.action.cancel')}
            </UIButton>
          )}
          <div className="flex max-w-full flex-col items-center gap-[4px]">
            <span className="text-[11px] text-[#a0a6b8]">{t('channels.wechat.qr.copyHint')}</span>
            <code className="max-w-[420px] text-center text-[11px] leading-[1.5] break-all select-all text-[#858b9c]">
              {qr.content}
            </code>
          </div>
        </div>
      )}
    </>
  );
}
