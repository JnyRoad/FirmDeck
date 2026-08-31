type RawPayload = {
  message: string;
};

/** Render external API and user data without treating unknown runtime values as product prose. */
export function ValidDataflowBoundaries({
  apiPayload,
  employeeName,
}: {
  apiPayload: RawPayload;
  employeeName: string;
}) {
  const defaultName = employeeName;
  const protocolMethod = 'POST';
  const rawPayload = apiPayload;

  return (
    <>
      <input defaultValue={defaultName} title={employeeName} />
      <pre>{rawPayload.message}</pre>
      <code>{protocolMethod}</code>
      <RawContent value={rawPayload.message} />
    </>
  );
}

/** Stand in for the explicit raw-content boundary used by the production renderer. */
function RawContent({ value }: { value: string }) {
  return <code translate="no" data-i18n-raw-kind="provider">{value}</code>;
}
