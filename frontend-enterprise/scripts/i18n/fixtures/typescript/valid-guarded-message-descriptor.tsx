type MessageId = 'fixture.guarded.message';

type MessageDescriptor = {
  id: MessageId;
};

type Translator = (id: MessageId) => string;

/** Narrow unknown runtime input to the governed descriptor contract without exposing raw content. */
function isMessageDescriptor(value: unknown): value is MessageDescriptor {
  return typeof value === 'object' && value !== null && 'id' in value;
}

/** Render a runtime descriptor only after a fail-closed type-predicate guard. */
export function ValidGuardedMessageDescriptor({
  t,
  value,
}: {
  t: Translator;
  value: unknown;
}) {
  if (!isMessageDescriptor(value)) return null;
  return <>{t(value.id)}</>;
}
