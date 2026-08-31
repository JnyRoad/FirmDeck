type MessageId =
  | 'fixture.helper.message'
  | 'fixture.descriptor.variable'
  | 'fixture.fallback.message'
  | 'fixture.map.message'
  | 'fixture.conditional.one'
  | 'fixture.conditional.two'
  | 'fixture.array.one'
  | 'fixture.array.two'
  | 'fixture.alias.one'
  | 'fixture.alias.two';

type Translator = (id: MessageId, values?: Record<string, unknown>) => string;
type ErrorTranslator = (error: unknown, fallbackId: MessageId) => string;

type MessageDescriptor = {
  id: MessageId;
};

const translate: Translator = (id) => id;
const translateError: ErrorTranslator = (_error, fallbackId) => fallbackId;
const descriptor: MessageDescriptor = { id: 'fixture.descriptor.variable' };
const messageIds = { ready: 'fixture.map.message' } as const satisfies Record<string, MessageId>;
const arrayIds = ['fixture.array.one', 'fixture.array.two'] as const satisfies readonly MessageId[];
const aliasId: MessageId = Math.random() > 0.5 ? 'fixture.alias.one' : 'fixture.alias.two';
const dynamicSegment = 'dynamic';

/** Exercise extraction through a typed translator and a descriptor variable. */
export function TypedHelperUsage({ intl }: { intl: { formatMessage: (value: MessageDescriptor) => string } }) {
  return (
    <>
      {translate('fixture.helper.message')}
      {intl.formatMessage(descriptor)}
      {translateError(new Error('fixture.error.raw'), 'fixture.fallback.message')}
      {translate(messageIds.ready)}
      {translate(arrayIds[0])}
      {translate(aliasId)}
      {translate(Math.random() > 0.5 ? 'fixture.conditional.one' : 'fixture.conditional.two')}
      {translate(`fixture.${dynamicSegment}.not-a-message-id`)}
    </>
  );
}
