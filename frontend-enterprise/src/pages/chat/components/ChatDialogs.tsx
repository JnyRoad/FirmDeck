import { ConfirmDialog } from '@/components/ConfirmDialog';
import EmployeeAvatar from '@/components/EmployeeAvatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { employeeDisplayNameWithCreator, employeeProfile } from '@/employee';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';

import {
  CHAT_CITATION_DETAIL_CLASS,
  CHAT_CITATION_DETAIL_EYEBROW_CLASS,
  CHAT_CITATION_DETAIL_GRID_CLASS,
  CHAT_CITATION_DETAIL_MARKDOWN_CLASS,
  CHAT_CITATION_DETAIL_NOTE_CLASS,
  CHAT_CITATION_DETAIL_SECTION_CLASS,
  CHAT_CITATION_DETAIL_TITLE_CLASS,
  CHAT_HANDOFF_ACTIONS_CLASS,
  CHAT_HANDOFF_BLOCK_CLASS,
  CHAT_HANDOFF_CARD_CLASS,
  CHAT_HANDOFF_EMPTY_CLASS,
  CHAT_HANDOFF_HEAD_CLASS,
  CHAT_HANDOFF_LIST_CLASS,
} from '../chatPageStyles';
import {
  citationSectionLabel,
  citationSourceLabel,
  MarkdownMessage,
} from '../chatHelpers';
import type { UseChatSession } from '../useChatSession';
import ChatModelSetupGate from './ChatModelSetupGate';

/** 汇总聊天页的模型门禁、交接、引用和会话管理弹窗，并区分产品 chrome 与 raw 内容。 */
export default function ChatDialogs({ chat }: { chat: UseChatSession }) {
  const { t } = useAppIntl();
  const {
    showHandoffInbox,
    setShowHandoffInbox,
    handoffs,
    handoffsLoading,
    handoffReplies,
    setHandoffReplies,
    submitHandoffReply,
    agents,
    displayedAgent,
    displayedProfile,
    openSession,
    activeCitation,
    setActiveCitation,
    renameSession,
    setRenameSession,
    renameTitle,
    setRenameTitle,
    saveRename,
    pendingDelete,
    setPendingDelete,
    confirmDeleteSession,
    canConfigureModels,
    modelSetupOpen,
    setModelSetupOpen,
    completeModelSetup,
  } = chat;

  return (
    <>
      <ChatModelSetupGate
        open={modelSetupOpen}
        canConfigure={canConfigureModels}
        onOpenChange={setModelSetupOpen}
        onConfigured={completeModelSetup}
      />

      <Dialog open={showHandoffInbox} onOpenChange={(open) => !open && setShowHandoffInbox(false)}>
        <DialogContent className="max-w-[min(920px,calc(100vw-40px))] sm:max-w-[920px]">
          <DialogHeader>
            <DialogTitle>{t('chat.dialog.handoffTitle')}</DialogTitle>
          </DialogHeader>
          {handoffs.length === 0 ? (
            <div className={CHAT_HANDOFF_EMPTY_CLASS}>
              {handoffsLoading ? t('chat.dialog.handoffLoading') : t('chat.dialog.handoffEmpty')}
            </div>
          ) : (
            <div className={CHAT_HANDOFF_LIST_CLASS}>
              {handoffs.map((handoff) => {
                const handoffAgent = handoff.agent_id
                  ? agents.find((item) => item.id === handoff.agent_id) || null
                  : displayedAgent;
                const profile = handoffAgent ? employeeProfile(handoffAgent) : displayedProfile;
                return (
                  <article className={CHAT_HANDOFF_CARD_CLASS} key={handoff.id}>
                    <div className={CHAT_HANDOFF_HEAD_CLASS}>
                      {profile ? <EmployeeAvatar profile={profile} size={36} radius={10} /> : null}
                      <div>
                        <strong>
                          {handoffAgent
                            ? <RawIdentifier value={employeeDisplayNameWithCreator(handoffAgent)} />
                            : t('chat.dialog.digitalEmployee')}
                        </strong>
                        <span>{t('chat.dialog.humanHandoff')}</span>
                      </div>
                    </div>
                    <div className={CHAT_HANDOFF_BLOCK_CLASS}>
                      <span>{t('chat.dialog.contextSummary')}</span>
                      {handoff.context_summary
                        ? <p><RawContent value={handoff.context_summary} /></p>
                        : <p>{t('chat.dialog.contextEmpty')}</p>}
                    </div>
                    <div className={CHAT_HANDOFF_BLOCK_CLASS}>
                      <span>{t('chat.dialog.pendingQuestion')}</span>
                      {handoff.pending_question
                        ? <p><RawContent value={handoff.pending_question} /></p>
                        : <p>{t('chat.dialog.pendingQuestionEmpty')}</p>}
                    </div>
                    <Textarea
                      rows={3}
                      value={handoffReplies[handoff.id] || ''}
                      placeholder={t('chat.dialog.handoffPlaceholder')}
                      onChange={(event) => setHandoffReplies((prev) => ({
                        ...prev,
                        [handoff.id]: event.target.value,
                      }))}
                    />
                    <div className={CHAT_HANDOFF_ACTIONS_CLASS}>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setShowHandoffInbox(false);
                          openSession(handoff.session_id);
                        }}
                      >
                        {t('chat.dialog.openConversation')}
                      </Button>
                      <Button onClick={() => submitHandoffReply(handoff)}>{t('chat.dialog.replyAndResume')}</Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(activeCitation)} onOpenChange={(open) => !open && setActiveCitation(null)}>
        <DialogContent className="max-w-[min(1160px,calc(100vw-40px))] sm:max-w-[1160px]">
          <DialogHeader>
            <DialogTitle>{t('chat.dialog.citationTitle')}</DialogTitle>
          </DialogHeader>
          {activeCitation && (
            <div className={CHAT_CITATION_DETAIL_CLASS}>
              <div className={CHAT_CITATION_DETAIL_EYEBROW_CLASS}>{citationKindText(activeCitation.kind, t)}</div>
              <h3 className={CHAT_CITATION_DETAIL_TITLE_CLASS}>
                <RawIdentifier value={citationDetailTitle(activeCitation, t)} />
              </h3>
              {citationDetailExcerpt(activeCitation) && (
                <div className={CHAT_CITATION_DETAIL_SECTION_CLASS}>
                  <span>{t('chat.dialog.citationExcerpt')}</span>
                  <CitationMarkdown content={citationDetailExcerpt(activeCitation)} />
                </div>
              )}
              {citationDetailSummary(activeCitation) && (
                <div className={CHAT_CITATION_DETAIL_SECTION_CLASS}>
                  <span>{t('chat.dialog.citationSummary')}</span>
                  <CitationMarkdown content={citationDetailSummary(activeCitation)} />
                </div>
              )}
              {(activeCitation.source_path || activeCitation.section_path || activeCitation.concept_id) && (
                <div className={CHAT_CITATION_DETAIL_GRID_CLASS}>
                  {activeCitation.source_path && (
                    <div>
                      <span>{t('chat.dialog.source')}</span>
                      <strong><RawIdentifier value={citationSourceLabel(activeCitation)} /></strong>
                    </div>
                  )}
                  {activeCitation.section_path && (
                    <div>
                      <span>{t('chat.dialog.section')}</span>
                      <strong><RawIdentifier value={citationSectionLabel(activeCitation)} /></strong>
                    </div>
                  )}
                  {activeCitation.concept_id && (
                    <div>
                      <span>{t('chat.dialog.knowledgeGraph')}</span>
                      <strong><RawIdentifier value={activeCitation.concept_id} /></strong>
                    </div>
                  )}
                </div>
              )}
              {activeCitation.confidence_reason && (
                <div className={CHAT_CITATION_DETAIL_NOTE_CLASS}>
                  <RawContent value={activeCitation.confidence_reason} />
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(renameSession)}
        onOpenChange={(open) => {
          if (!open) {
            setRenameSession(null);
            setRenameTitle('');
          }
        }}
      >
        <DialogContent className="gap-0 overflow-hidden rounded-[16px] p-0">
          <DialogHeader className="px-[16px] pt-[16px] pb-[12px]">
            <DialogTitle className="text-[14px] leading-[normal] font-medium text-[#18181a]">
              {t('chat.dialog.renameTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="px-[16px] pb-[4px]">
            <Input
              autoFocus
              maxLength={80}
              value={renameTitle}
              onChange={(event) => setRenameTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void saveRename();
                }
              }}
              placeholder={t('chat.dialog.renamePlaceholder')}
            />
          </div>
          <div className="flex items-center justify-end gap-[8px] pt-[12px] pr-[16px] pb-[16px] pl-[12px]">
            <Button
              variant="outline"
              className="h-[32px] w-[80px] rounded-[10px] border-[#e3e7f1] bg-white px-[12px] py-[8px] text-[14px] font-normal text-[#464c5e] hover:border-[#e3e7f1] hover:bg-[#f6f6f6] hover:text-primary"
              onClick={() => {
                setRenameSession(null);
                setRenameTitle('');
              }}
            >
              {t('common.action.cancel')}
            </Button>
            <Button
              className="h-[32px] w-[80px] rounded-[10px] bg-primary px-[12px] py-[8px] text-[14px] font-normal text-white hover:bg-primary/80"
              onClick={() => void saveRename()}
            >
              {t('common.action.save')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t('chat.dialog.deleteTitle')}
        description={t('chat.dialog.deleteDescription')}
        onConfirm={() => void confirmDeleteSession()}
      />
    </>
  );
}

/** 渲染引用原文 Markdown；引用内容属于业务数据，不参与产品文案翻译。 */
function CitationMarkdown({ content }: { content: string }) {
  return (
    <div
      className={CHAT_CITATION_DETAIL_MARKDOWN_CLASS}
      translate="no"
      data-i18n-raw-kind="content"
    >
      <MarkdownMessage content={content} preserveLineBreaks={false} />
    </div>
  );
}

/** 将引用类型枚举映射到稳定产品消息，未知类型安全使用通用引用标签。 */
function citationKindText(
  kind: NonNullable<UseChatSession['activeCitation']>['kind'],
  translate: ReturnType<typeof useAppIntl>['t'],
): string {
  if (kind === 'concept' || kind === 'okf') return translate('chat.dialog.knowledgeGraph');
  return translate('chat.dialog.citationExcerpt');
}

/** 提取引用标题原始值；只有无标题时才显示本地化产品 fallback。 */
function citationDetailTitle(
  citation: NonNullable<UseChatSession['activeCitation']>,
  translate: ReturnType<typeof useAppIntl>['t'],
): string {
  const raw = citation.title || citation.section_path || citation.source_path || citation.concept_id;
  return raw?.trim() || translate('chat.dialog.citationTitle');
}

function citationDetailExcerpt(citation: NonNullable<UseChatSession['activeCitation']>): string {
  return String(citation.content || citation.excerpt || citation.summary || '').trim();
}

function citationDetailSummary(citation: NonNullable<UseChatSession['activeCitation']>): string {
  const summary = String(citation.summary || '').trim();
  const content = String(citation.content || citation.excerpt || '').trim();
  return summary && summary !== content ? summary : '';
}
