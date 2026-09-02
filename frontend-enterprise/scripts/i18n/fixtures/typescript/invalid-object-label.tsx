type CredentialField = {
  key: string;
  label: string;
};

const DEFAULT_FIELDS: CredentialField[] = [
  { key: 'bot_id', label: 'Bot ID' },
  { key: 'secret', label: 'Bot secret' },
];

/** Exercise local object configuration whose label property flows into rendered JSX. */
export function InvalidObjectLabel({ remoteFields }: { remoteFields: CredentialField[] }) {
  const fields = remoteFields.length > 0 ? remoteFields : DEFAULT_FIELDS;
  return fields.map((field) => <label key={field.key}>{field.label}</label>);
}
