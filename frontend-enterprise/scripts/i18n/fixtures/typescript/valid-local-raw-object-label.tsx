type RawProvider = {
  id: string;
  label: string;
};

const RAW_PROVIDERS: RawProvider[] = [{ id: 'openai', label: 'OpenAI' }];

/** Preserve an explicitly raw local provider name without granting a broad subtree ignore. */
export function ValidLocalRawObjectLabel() {
  return RAW_PROVIDERS.map((provider) => (
    <code key={provider.id}>{provider.label}</code>
  ));
}
