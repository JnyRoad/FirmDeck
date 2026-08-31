type MessageId = 'fixture.dialog.title';

type MessageDescriptor = {
  id: MessageId;
};

type IntlShape = {
  formatMessage: (descriptor: MessageDescriptor) => string;
};

/** Render descriptors whose object and property forms both retain the MessageId contract. */
export function ValidMessageDescriptor({
  descriptor,
  intl,
}: {
  descriptor: MessageDescriptor;
  intl: IntlShape;
}) {
  return (
    <>
      {intl.formatMessage(descriptor)}
      {intl.formatMessage({ id: descriptor.id })}
    </>
  );
}
