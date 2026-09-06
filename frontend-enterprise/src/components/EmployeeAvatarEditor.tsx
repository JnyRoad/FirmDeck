import { CheckOutlined, UploadOutlined } from '../icons';
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui';
import { createToastNotifier } from '@/components/ui/app-toast';
import { createMessageDescriptor, type MessageDescriptor } from '@/i18n/descriptors';
import { RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import type { MessageId } from '@/i18n/types';
import { backendErrorMessageDescriptor } from '@/lib/apiErrorMessages';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createTenantClient } from '../api/tenant-client';
import { useTenantSession } from '../contexts/TenantSessionContext';
import {
  EMPLOYEE_AVATAR_PRESETS,
  employeeDisplayName,
  employeeProfile,
  type EmployeeProfile,
} from '../employee';
import type { AgentProfileRead } from '../types';
import EmployeeAvatar from './EmployeeAvatar';

const MAX_INPUT_IMAGE_BYTES = 5 * 1024 * 1024;
const AVATAR_CANVAS_SIZE = 360;

const AVATAR_PRESET_MESSAGE_IDS: Record<string, MessageId> = {
  'service-orbit': 'employeeAvatar.preset.serviceOrbit',
  'after-sales-seal': 'employeeAvatar.preset.afterSalesSeal',
  'knowledge-node': 'employeeAvatar.preset.knowledgeNode',
  'commerce-compass': 'employeeAvatar.preset.commerceCompass',
  'ops-grid': 'employeeAvatar.preset.opsGrid',
  'quality-star': 'employeeAvatar.preset.qualityStar',
  'sales-handshake': 'employeeAvatar.preset.salesHandshake',
  'marketing-spark': 'employeeAvatar.preset.marketingSpark',
  'procurement-check': 'employeeAvatar.preset.procurementCheck',
  'project-board': 'employeeAvatar.preset.projectBoard',
  'data-insight': 'employeeAvatar.preset.dataInsight',
  'customer-service': 'employeeAvatar.preset.customerService',
  'operations-flow': 'employeeAvatar.preset.operationsFlow',
  'it-support': 'employeeAvatar.preset.itSupport',
  'brand-design': 'employeeAvatar.preset.brandDesign',
  'training-coach': 'employeeAvatar.preset.trainingCoach',
  'strategy-compass': 'employeeAvatar.preset.strategyCompass',
  'teacher-f': 'employeeAvatar.preset.teacherF',
  'teacher-m': 'employeeAvatar.preset.teacherM',
  'doctor-f': 'employeeAvatar.preset.doctorF',
  'doctor-m': 'employeeAvatar.preset.doctorM',
  'nurse-f': 'employeeAvatar.preset.nurseF',
  'nurse-m': 'employeeAvatar.preset.nurseM',
  'chef-f': 'employeeAvatar.preset.chefF',
  'chef-m': 'employeeAvatar.preset.chefM',
  'designer-f': 'employeeAvatar.preset.designerF',
  'designer-m': 'employeeAvatar.preset.designerM',
  'lawyer-f': 'employeeAvatar.preset.lawyerF',
  'lawyer-m': 'employeeAvatar.preset.lawyerM',
  'driver-f': 'employeeAvatar.preset.driverF',
  'driver-m': 'employeeAvatar.preset.driverM',
  'retail-f': 'employeeAvatar.preset.retailF',
  'retail-m': 'employeeAvatar.preset.retailM',
  'courier-f': 'employeeAvatar.preset.courierF',
  'courier-m': 'employeeAvatar.preset.courierM',
  'stylist-f': 'employeeAvatar.preset.stylistF',
  'stylist-m': 'employeeAvatar.preset.stylistM',
  'photographer-f': 'employeeAvatar.preset.photographerF',
  'photographer-m': 'employeeAvatar.preset.photographerM',
  'waiter-f': 'employeeAvatar.preset.waiterF',
  'waiter-m': 'employeeAvatar.preset.waiterM',
  'trainer-f': 'employeeAvatar.preset.trainerF',
  'trainer-m': 'employeeAvatar.preset.trainerM',
  'video-editor-f': 'employeeAvatar.preset.videoEditorF',
  'video-editor-m': 'employeeAvatar.preset.videoEditorM',
  'storyboard-artist-f': 'employeeAvatar.preset.storyboardArtistF',
  'storyboard-artist-m': 'employeeAvatar.preset.storyboardArtistM',
  'content-researcher-f': 'employeeAvatar.preset.contentResearcherF',
  'content-researcher-m': 'employeeAvatar.preset.contentResearcherM',
  'copywriter-f': 'employeeAvatar.preset.copywriterF',
  'copywriter-m': 'employeeAvatar.preset.copywriterM',
  'ai-image-artist-f': 'employeeAvatar.preset.aiImageArtistF',
  'ai-image-artist-m': 'employeeAvatar.preset.aiImageArtistM',
  'ai-video-artist-f': 'employeeAvatar.preset.aiVideoArtistF',
  'ai-video-artist-m': 'employeeAvatar.preset.aiVideoArtistM',
  'livestream-host-f': 'employeeAvatar.preset.livestreamHostF',
  'livestream-host-m': 'employeeAvatar.preset.livestreamHostM',
  'livestream-control-f': 'employeeAvatar.preset.livestreamControlF',
  'livestream-control-m': 'employeeAvatar.preset.livestreamControlM',
  'xiaohongshu-ops-f': 'employeeAvatar.preset.xiaohongshuOpsF',
  'xiaohongshu-ops-m': 'employeeAvatar.preset.xiaohongshuOpsM',
  'douyin-ops-f': 'employeeAvatar.preset.douyinOpsF',
  'douyin-ops-m': 'employeeAvatar.preset.douyinOpsM',
  'wechat-channels-ops-f': 'employeeAvatar.preset.wechatChannelsOpsF',
  'wechat-channels-ops-m': 'employeeAvatar.preset.wechatChannelsOpsM',
  'wechat-article-editor-f': 'employeeAvatar.preset.wechatArticleEditorF',
  'wechat-article-editor-m': 'employeeAvatar.preset.wechatArticleEditorM',
  'short-video-ops-f': 'employeeAvatar.preset.shortVideoOpsF',
  'short-video-ops-m': 'employeeAvatar.preset.shortVideoOpsM',
  'community-ops-f': 'employeeAvatar.preset.communityOpsF',
  'community-ops-m': 'employeeAvatar.preset.communityOpsM',
  'product-curator-f': 'employeeAvatar.preset.productCuratorF',
  'product-curator-m': 'employeeAvatar.preset.productCuratorM',
  'ecommerce-service-f': 'employeeAvatar.preset.ecommerceServiceF',
  'ecommerce-service-m': 'employeeAvatar.preset.ecommerceServiceM',
  'kol-liaison-f': 'employeeAvatar.preset.kolLiaisonF',
  'kol-liaison-m': 'employeeAvatar.preset.kolLiaisonM',
  'listing-designer-f': 'employeeAvatar.preset.listingDesignerF',
  'listing-designer-m': 'employeeAvatar.preset.listingDesignerM',
};

const AVATAR_UPLOAD_ERRORS = {
  read: 'AVATAR_READ_FAILED',
  image: 'AVATAR_IMAGE_INVALID',
  file: 'AVATAR_FILE_REQUIRED',
  size: 'AVATAR_FILE_TOO_LARGE',
  processing: 'AVATAR_PROCESSING_UNAVAILABLE',
} as const;

type AvatarDraft = Pick<EmployeeProfile, 'avatarKind' | 'avatarImage' | 'avatarPreset' | 'avatarText' | 'avatarTone'>;

export default function EmployeeAvatarEditor({
  agent,
  open,
  onClose,
  onSaved,
}: {
  agent?: AgentProfileRead | null;
  open: boolean;
  onClose: () => void;
  onSaved?: (agent: AgentProfileRead) => void;
}) {
  const { t } = useAppIntl();
  const toast = createToastNotifier({ t });
  const tenantContext = useTenantSession();
  const tenantApi = useMemo(() => createTenantClient(tenantContext), [tenantContext]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<'preset' | 'upload'>('preset');
  const [selectedPreset, setSelectedPreset] = useState(EMPLOYEE_AVATAR_PRESETS[0].key);
  const [uploadedImage, setUploadedImage] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !agent) return;
    const profile = employeeProfile(agent);
    setMode(profile.avatarKind);
    setSelectedPreset(profile.avatarPreset || EMPLOYEE_AVATAR_PRESETS[0].key);
    setUploadedImage(profile.avatarImage || '');
  }, [agent, open]);

  const selected = EMPLOYEE_AVATAR_PRESETS.find((item) => item.key === selectedPreset) || EMPLOYEE_AVATAR_PRESETS[0];
  const profile: AvatarDraft = mode === 'upload' && uploadedImage
    ? {
      avatarKind: 'upload',
      avatarImage: uploadedImage,
      avatarPreset: selected.key,
      avatarText: selected.text,
      avatarTone: selected.tone,
    }
    : {
      avatarKind: 'preset',
      avatarImage: '',
      avatarPreset: selected.key,
      avatarText: selected.text,
      avatarTone: selected.tone,
    };

  /** Accept and normalize an image file; user-facing errors are projected to descriptors. */
  async function handleUpload(file: File | undefined) {
    if (!file) return;
    const context = tenantContext;
    const generation = context?.generation;
    if (!context || generation === undefined) return;
    try {
      const dataUrl = await fileToAvatarDataUrl(file);
      if (!context.isCurrentGeneration(generation)) return;
      setUploadedImage(dataUrl);
      setMode('upload');
    } catch (error) {
      if (context.isCurrentGeneration(generation)) {
        toast.error(avatarUploadErrorDescriptor(error));
      }
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  /** Persist the selected avatar metadata and expose only stable toast descriptors. */
  async function save() {
    const context = tenantContext;
    const generation = context?.generation;
    if (!agent || !context || generation === undefined) return;
    setSaving(true);
    try {
      const metadata = { ...(agent.metadata || {}) };
      metadata.avatar_kind = profile.avatarKind;
      metadata.avatar_preset = profile.avatarPreset;
      metadata.avatar_text = profile.avatarText;
      metadata.avatar_tone = profile.avatarTone;
      if (profile.avatarKind === 'upload' && profile.avatarImage) {
        metadata.avatar_image = profile.avatarImage;
      } else {
        delete metadata.avatar_image;
      }

      const saved = await tenantApi.put<AgentProfileRead>(`/api/enterprise/agents/${agent.id}`, {
        metadata,
      });
      if (!context.isCurrentGeneration(generation)) return;
      toast.success(createMessageDescriptor('employeeAvatar.toast.updated'));
      onSaved?.(saved);
      onClose();
      window.dispatchEvent(new Event('ultrarag-enterprise-agent-scope-refresh'));
    } catch (error) {
      if (!context.isCurrentGeneration(generation)) return;
      const descriptor = backendErrorMessageDescriptor(error);
      toast.error(descriptor
        ? { id: descriptor.messageId, values: descriptor.values }
        : createMessageDescriptor('employeeAvatar.toast.saveFailed'));
    } finally {
      if (context.isCurrentGeneration(generation)) setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[calc(100dvh-4rem)] w-[calc(100%-2rem)] flex-col gap-4 overflow-hidden rounded-[14px] px-5 py-4 sm:max-w-[680px]"
      >
        <DialogHeader className="px-3">
          <DialogTitle className="text-sm font-normal leading-none text-[#757f9c]">
            {agent ? (
              <>
                <span>{t('employeeAvatar.dialog.title')}</span>
                <span aria-hidden="true">{t('employeeAvatar.dialog.titleSeparator')}</span>
                <RawIdentifier value={employeeDisplayName(agent)} />
              </>
            ) : t('employeeAvatar.dialog.title')}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-[18px] overflow-y-auto px-3">
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-[18px] rounded-2xl border border-border bg-[linear-gradient(135deg,color-mix(in_srgb,var(--accent-soft)_34%,transparent),transparent_58%),var(--surface-subtle)] p-[18px]">
            <EmployeeAvatar profile={profile} width={104} height={122} />
            <div>
              <strong className="block text-sm text-foreground">
                {mode === 'upload' ? t('employeeAvatar.mode.custom') : t(AVATAR_PRESET_MESSAGE_IDS[selected.key])}
              </strong>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('employeeAvatar.preview.description')}
              </p>
            </div>
          </div>

          <section className="space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <strong className="text-[13px] text-foreground">{t('employeeAvatar.preset.heading')}</strong>
              <span className="text-xs text-muted-foreground">{t('employeeAvatar.preset.hint')}</span>
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              {EMPLOYEE_AVATAR_PRESETS.map((preset) => {
                const active = mode === 'preset' && selectedPreset === preset.key;
                return (
                  <button
                    key={preset.key}
                    type="button"
                    data-active={active}
                    onClick={() => {
                      setSelectedPreset(preset.key);
                      setMode('preset');
                    }}
                    className="grid min-h-[88px] min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 rounded-[14px] border border-border bg-(--surface) p-3 text-left text-foreground transition-all hover:-translate-y-px hover:border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] hover:shadow-[0_14px_30px_rgba(30,24,16,0.08)] data-[active=true]:-translate-y-px data-[active=true]:border-[color-mix(in_srgb,var(--accent)_45%,var(--border))] data-[active=true]:shadow-[0_14px_30px_rgba(30,24,16,0.08)]"
                  >
                    <EmployeeAvatar
                      profile={{
                        avatarKind: 'preset',
                        avatarImage: '',
                        avatarPreset: preset.key,
                        avatarText: preset.text,
                        avatarTone: preset.tone,
                      }}
                      size={52}
                    />
                    <span className="min-w-0 truncate text-left font-[760]">
                      {t(AVATAR_PRESET_MESSAGE_IDS[preset.key])}
                    </span>
                    {active && <CheckOutlined className="text-accent" />}
                  </button>
                );
              })}
            </div>
          </section>

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="flex w-full items-center gap-3.5 rounded-2xl border border-dashed border-[color-mix(in_srgb,var(--accent)_30%,var(--border))] bg-[linear-gradient(135deg,color-mix(in_srgb,var(--accent-soft)_26%,transparent),transparent_62%),var(--surface-subtle)] px-4 py-3.5 text-left transition-all hover:border-[color-mix(in_srgb,var(--accent)_52%,var(--border))] hover:shadow-[0_12px_28px_rgba(30,24,16,0.07)] focus-visible:border-[color-mix(in_srgb,var(--accent)_60%,var(--border))] focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)] focus-visible:outline-none"
          >
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => void handleUpload(event.target.files?.[0])}
            />
            <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-[color-mix(in_srgb,var(--accent)_12%,var(--surface))] text-lg text-accent">
              <UploadOutlined />
            </span>
            <span className="grid min-w-0 gap-0.5">
              <span className="text-sm font-semibold text-foreground">{t('employeeAvatar.upload.action')}</span>
              <span className="text-xs text-muted-foreground">{t('employeeAvatar.upload.hint')}</span>
            </span>
          </button>
        </div>

        <DialogFooter className="gap-2 px-3 py-0 sm:justify-end">
          <Button
            variant="outline"
            disabled={saving}
            onClick={onClose}
            className="h-8 w-[92px] rounded-[10px] border-[#e3e7f1] bg-white px-3 text-sm font-normal text-[#464c5e] hover:border-[#e3e7f1] hover:bg-[#f6f6f6] hover:text-primary"
          >
            {t('employeeAvatar.action.cancel')}
          </Button>
          <Button
            disabled={saving}
            onClick={() => void save()}
            className="h-8 w-[92px] rounded-[10px] bg-primary px-3 text-sm font-normal text-white hover:bg-primary/80"
          >
            {t('employeeAvatar.action.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Read a selected file as a data URL; technical failures use stable private codes. */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(AVATAR_UPLOAD_ERRORS.read));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

/** Decode an avatar data URL; malformed image data is never exposed as UI text. */
function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error(AVATAR_UPLOAD_ERRORS.image));
    image.onload = () => resolve(image);
    image.src = dataUrl;
  });
}

/** Crop an uploaded image to the avatar contract while retaining no user-facing raw error. */
async function fileToAvatarDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error(AVATAR_UPLOAD_ERRORS.file);
  }
  if (file.size > MAX_INPUT_IMAGE_BYTES) {
    throw new Error(AVATAR_UPLOAD_ERRORS.size);
  }

  const image = await loadImage(await readFileAsDataUrl(file));
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_CANVAS_SIZE;
  canvas.height = AVATAR_CANVAS_SIZE;
  const context = canvas.getContext('2d');
  if (!context) throw new Error(AVATAR_UPLOAD_ERRORS.processing);

  const side = Math.min(image.width, image.height);
  const sx = Math.max(0, (image.width - side) / 2);
  const sy = Math.max(0, (image.height - side) / 2);
  context.fillStyle = '#f7f4ee';
  context.fillRect(0, 0, AVATAR_CANVAS_SIZE, AVATAR_CANVAS_SIZE);
  context.drawImage(image, sx, sy, side, side, 0, 0, AVATAR_CANVAS_SIZE, AVATAR_CANVAS_SIZE);

  const png = canvas.toDataURL('image/png');
  return png.length < 650_000 ? png : canvas.toDataURL('image/jpeg', 0.86);
}

/** Map private avatar-processing failures to stable localized descriptors. */
function avatarUploadErrorDescriptor(error: unknown): MessageDescriptor {
  const code = error instanceof Error ? error.message : '';
  switch (code) {
    case AVATAR_UPLOAD_ERRORS.file:
      return createMessageDescriptor('employeeAvatar.error.fileRequired');
    case AVATAR_UPLOAD_ERRORS.size:
      return createMessageDescriptor('employeeAvatar.error.tooLarge');
    case AVATAR_UPLOAD_ERRORS.image:
      return createMessageDescriptor('employeeAvatar.error.imageInvalid');
    case AVATAR_UPLOAD_ERRORS.processing:
      return createMessageDescriptor('employeeAvatar.error.processingUnavailable');
    default:
      return createMessageDescriptor('employeeAvatar.error.readFailed');
  }
}
