/** Render raw business values in attributes without adding product-authored prose. */
export function ValidRawAttributes({
  attachmentName,
  providerName,
}: {
  attachmentName: string;
  providerName: string;
}) {
  return <img alt={providerName} title={attachmentName} src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" />;
}
