type MessageId = 'fixture.message.identifier';

type Translator = (id: MessageId) => string;

/** Render one message selected through a variable whose type is the governed MessageId union. */
export function ValidMessageIdIdentifier({ t }: { t: Translator }) {
  const messageId: MessageId = 'fixture.message.identifier';
  return <>{t(messageId)}</>;
}
