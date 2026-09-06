import FirmdeckIcon from '@/components/FirmdeckIcon';
import { RawContent, RawIdentifier } from '@/i18n/RawContent';
import { useAppIntl } from '@/i18n/useAppIntl';
import type { ChatSlashCommand } from '@/types';

import {
  CHAT_COMPOSER_COMMAND_CHIP_CLASS,
  CHAT_COMPOSER_COMMAND_ICON_CLASS,
  CHAT_COMPOSER_COMMAND_KIND_CLASS,
  CHAT_COMPOSER_COMMAND_LABEL_CLASS,
  CHAT_COMPOSER_COMMAND_REMOVE_CLASS,
} from '../chatPageStyles';
type SlashCommandChipProps = {
  command: ChatSlashCommand;
  onRemove?: () => void;
  removeLabel?: string;
};

/** 展示 slash command chip；命令名称、说明和协议值属于业务/技术原文。 */
export default function SlashCommandChip({
  command,
  onRemove,
  removeLabel,
}: SlashCommandChipProps) {
  const { t } = useAppIntl();
  const kindLabel = command.kind === 'sop'
    ? t('chat.composer.kind.sop')
    : command.kind === 'skill'
      ? t('chat.composer.kind.skill')
      : t('chat.composer.kind.tool');
  const resolvedRemoveLabel = removeLabel || t('chat.composer.removeCommandWithName', {
    label: command.label,
  });
  return (
    <span
      className={CHAT_COMPOSER_COMMAND_CHIP_CLASS}
      role="group"
      aria-label={t('chat.composer.commandAriaLabel', {
        kind: kindLabel,
        label: command.label,
      })}
      title={command.command}
      data-chat-slash-command={command.command}
    >
      <span className={CHAT_COMPOSER_COMMAND_ICON_CLASS} aria-hidden="true">
        <FirmdeckIcon
          name={command.kind === 'sop' ? 'branch' : command.kind === 'skill' ? 'spark' : 'tool'}
          size={13}
        />
      </span>
      <span className={CHAT_COMPOSER_COMMAND_LABEL_CLASS}>
        <RawIdentifier value={command.label} />
      </span>
      <span className={CHAT_COMPOSER_COMMAND_KIND_CLASS}>{kindLabel}</span>
      <span className="sr-only"><RawContent value={command.description || command.command} /></span>
      {onRemove && (
        <button
          type="button"
          className={CHAT_COMPOSER_COMMAND_REMOVE_CLASS}
          onClick={onRemove}
          aria-label={resolvedRemoveLabel}
          title={resolvedRemoveLabel}
        >
          ×
        </button>
      )}
    </span>
  );
}
