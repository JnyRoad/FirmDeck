type UnsafeDescriptor = {
  id: string;
};

type Translator = (id: string) => string;

/** Exercise an unvalidated descriptor property that must not bypass semantic-ID governance. */
export function InvalidMessageIdProperty({
  descriptor,
  t,
}: {
  descriptor: UnsafeDescriptor;
  t: Translator;
}) {
  return <>{t(descriptor.id)}</>;
}
