type ExternalField = {
  key: string;
  label: string;
};

/** Render externally supplied labels without treating their runtime business values as literals. */
export function ValidExternalObjectLabel({ fields }: { fields: ExternalField[] }) {
  return fields.map((field) => <label key={field.key}>{field.label}</label>);
}
