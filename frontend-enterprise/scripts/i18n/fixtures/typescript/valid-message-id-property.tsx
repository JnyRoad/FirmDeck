type MessageId = 'fixture.navigation.label';

type NavigationItem = {
  labelId: MessageId;
};

type Translator = (id: MessageId) => string;

/** Render one message selected through a property explicitly typed as MessageId. */
export function ValidMessageIdProperty({
  item,
  t,
}: {
  item: NavigationItem;
  t: Translator;
}) {
  return <>{t(item.labelId)}</>;
}
