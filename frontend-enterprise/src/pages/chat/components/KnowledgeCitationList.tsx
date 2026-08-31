import StaffdeckIcon from '@/components/StaffdeckIcon';
import { RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import type { KnowledgeCitation } from '@/types';

import {
  CHAT_CITATION_CHIP_CLASS,
  CHAT_CITATION_HEADING_CLASS,
  CHAT_CITATION_INDEX_CLASS,
  CHAT_CITATION_LIST_CLASS,
  CHAT_CITATION_TITLE_CLASS,
  CHAT_CITATIONS_CLASS,
} from '../chatPageStyles';
import { citationDisplayTitle } from '../chatHelpers';

type KnowledgeCitationListProps = {
  citations: KnowledgeCitation[];
  onOpen: (citation: KnowledgeCitation) => void;
};

/** 展示知识引用入口；来源 ID、标题和片段标题都是业务数据，保持原始内容。 */
export default function KnowledgeCitationList({
  citations,
  onOpen,
}: KnowledgeCitationListProps) {
  const { t } = useAppIntl();
  if (citations.length === 0) return null;

  return (
    <div className={CHAT_CITATIONS_CLASS} aria-label={t('chat.dialog.citations')}>
      <div className={CHAT_CITATION_HEADING_CLASS}>
        <StaffdeckIcon name="file" size={14} />
        <span>{t('chat.dialog.citationSources')}</span>
      </div>
      <div className={CHAT_CITATION_LIST_CLASS}>
        {citations.map((citation) => (
          <button
            key={citation.id}
            type="button"
            className={CHAT_CITATION_CHIP_CLASS}
            onClick={() => onOpen(citation)}
          >
            <span className={CHAT_CITATION_INDEX_CLASS}>
              <RawIdentifier value={citation.label || citation.id} />
            </span>
            <span className={CHAT_CITATION_TITLE_CLASS}>
              {citationDisplayTitle(citation)
                ? <RawIdentifier value={citationDisplayTitle(citation)} />
                : t('chat.dialog.knowledgeCitation')}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
