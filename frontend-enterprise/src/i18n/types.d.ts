/**
 * 从英文规范目录派生 MessageId，并把 FirmDeck locale/message 联合类型注入 FormatJS。
 */

import canonicalMessages from './messages/en-US.json';
import type { AppLocale as RegisteredAppLocale } from './locales';

export type AppLocale = RegisteredAppLocale;
export type MessageId = keyof typeof canonicalMessages;

declare global {
  namespace FormatjsIntl {
    interface Message {
      ids: MessageId;
    }

    interface IntlConfig {
      locale: AppLocale;
    }
  }
}

export {};
