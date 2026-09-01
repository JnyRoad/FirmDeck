import { forwardRef, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import IconFieldEye from '../assets/icons/field-eye.svg?react';
import IconFieldEyeOn from '../assets/icons/field-eye-on.svg?react';
import AppHeader from '../components/AppHeader';
import BrandLogo from '../components/BrandLogo';
import { setEnterpriseAuthSession, type EnterpriseAuthSession } from '../auth';
import { useAppIntl } from '../i18n/useAppIntl';

export type ChangePasswordClient = {
  changePassword(input: {
    current_password: string;
    new_password: string;
  }): Promise<EnterpriseAuthSession>;
};

export type ChangePasswordPageProps = {
  session: EnterpriseAuthSession;
  client: ChangePasswordClient;
  onComplete: (session: EnterpriseAuthSession) => void;
  onCancel?: () => void;
};

const NEW_PASSWORD_MIN_LENGTH = 12;
const INPUT_BASE_CLASS =
  'h-[44px] w-full rounded-[10px] border border-[#e3e7f1] bg-white px-[16px] text-[14px] text-[#18181a] outline-none transition-colors placeholder:text-[#858b9c] focus:border-[#18181a] focus:ring-2 focus:ring-[#18181a]/10 disabled:cursor-not-allowed disabled:opacity-60';

type PasswordField = 'current' | 'next' | 'confirm';

/**
 * Forced password-change screen. It accepts opaque password bytes as entered;
 * only the local minimum-length and confirmation rules are applied before the
 * authenticated client receives them.
 */
export default function ChangePasswordPage({
  session: _session,
  client,
  onComplete,
  onCancel,
}: ChangePasswordPageProps) {
  const { t } = useAppIntl();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [visible, setVisible] = useState<Record<PasswordField, boolean>>({
    current: false,
    next: false,
    confirm: false,
  });
  const [currentError, setCurrentError] = useState('');
  const [newError, setNewError] = useState('');
  const [confirmationError, setConfirmationError] = useState('');
  const [formError, setFormError] = useState('');
  const [loading, setLoading] = useState(false);
  const currentFieldRef = useRef<HTMLInputElement>(null);
  const newFieldRef = useRef<HTMLInputElement>(null);
  const confirmationFieldRef = useRef<HTMLInputElement>(null);

  // Keep the authenticated session in the prop contract even though no raw
  // tenant/user identifier is rendered on this credential-only screen.
  void _session;

  useEffect(() => {
    currentFieldRef.current?.focus();
  }, []);

  function clearSecrets() {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmation('');
    setVisible({ current: false, next: false, confirm: false });
  }

  function clearErrors() {
    setCurrentError('');
    setNewError('');
    setConfirmationError('');
    setFormError('');
  }

  function cancel() {
    if (loading) return;
    clearSecrets();
    clearErrors();
    onCancel?.();
  }

  function validate(): boolean {
    const nextCurrentError = currentPassword.length > 0
      ? ''
      : t('auth.changePassword.currentRequired');
    const nextNewError = newPassword.length >= NEW_PASSWORD_MIN_LENGTH
      ? ''
      : t('auth.changePassword.minimumLength');
    const nextConfirmationError = confirmation === newPassword && confirmation.length > 0
      ? ''
      : t('auth.changePassword.mismatch');

    setCurrentError(nextCurrentError);
    setNewError(nextNewError);
    setConfirmationError(nextConfirmationError);
    setFormError(nextCurrentError || nextNewError || nextConfirmationError);

    if (nextCurrentError) {
      currentFieldRef.current?.focus();
    } else if (nextNewError) {
      newFieldRef.current?.focus();
    } else if (nextConfirmationError) {
      confirmationFieldRef.current?.focus();
    }

    return !nextCurrentError && !nextNewError && !nextConfirmationError;
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (loading || !validate()) return;

    setLoading(true);
    try {
      let replacementSession: EnterpriseAuthSession;
      try {
        // Do not trim or otherwise normalize either password field. The server
        // receives precisely the bytes the user entered in current/new fields.
        replacementSession = await client.changePassword({
          current_password: currentPassword,
          new_password: newPassword,
        });
      } catch {
        // Never project an upstream body, exception, or entered secret to the UI.
        clearSecrets();
        setFormError(t('auth.changePassword.failure'));
        return;
      }

      // Backend success is authoritative. If the browser storage quota or
      // policy rejects persistence, still advance the in-memory App session
      // with the replacement token; the caller can decide when to re-persist.
      clearSecrets();
      try {
        setEnterpriseAuthSession(replacementSession);
      } catch {
        // Deliberately keep this out of the backend-failure UX. The replacement
        // session is still passed to onComplete below.
      }
      clearErrors();
      onComplete(replacementSession);
    } finally {
      setLoading(false);
    }
  }

  function onFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  }

  function toggleVisible(field: PasswordField) {
    setVisible((previous) => ({ ...previous, [field]: !previous[field] }));
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#f7f9fc] text-[#18181a]">
      <AppHeader
        className="h-[60px] shrink-0 border-b border-[#e6eaf1] bg-white px-[32px]"
        left={<BrandLogo markSize={28} />}
        right={null}
      />

      <main className="flex flex-1 items-center justify-center px-5 py-12 sm:px-8">
        <section className="w-full max-w-[440px] rounded-[18px] border border-[#e3e8f1] bg-white p-6 shadow-[0_18px_55px_rgba(35,61,102,0.08)] sm:p-9">
          <div className="mb-8 text-center">
            <h1 className="text-[26px] font-semibold tracking-[-0.02em] text-[#18181a]">
              {t('auth.changePassword.title')}
            </h1>
            <p className="mt-2 text-[13px] leading-5 text-[#7d879a]">
              {t('auth.changePassword.description')}
            </p>
          </div>

          <form
            className="grid gap-5"
            onSubmit={(event) => void submit(event)}
            onKeyDown={onFormKeyDown}
            noValidate
            aria-busy={loading}
          >
            <div className="grid gap-2">
              <label htmlFor="change-password-current" className="text-[13px] font-medium text-[#464c5e]">
                {t('auth.changePassword.currentLabel')}
              </label>
              <PasswordInput
                id="change-password-current"
                name="current_password"
                ref={currentFieldRef}
                value={currentPassword}
                visible={visible.current}
                label={t('auth.changePassword.currentLabel')}
                placeholder={t('auth.changePassword.currentPlaceholder')}
                error={currentError}
                errorId="change-password-current-error"
                autoComplete="current-password"
                disabled={loading}
                onChange={(value) => {
                  setCurrentPassword(value);
                  setCurrentError('');
                  setFormError('');
                }}
                onToggle={() => toggleVisible('current')}
                showLabel={t('auth.changePassword.showPassword')}
                hideLabel={t('auth.changePassword.hidePassword')}
              />
              {currentError && (
                <p id="change-password-current-error" className="text-[12px] text-[#c43b3b]">
                  {currentError}
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <label htmlFor="change-password-new" className="text-[13px] font-medium text-[#464c5e]">
                {t('auth.changePassword.newLabel')}
              </label>
              <PasswordInput
                id="change-password-new"
                name="new_password"
                ref={newFieldRef}
                value={newPassword}
                visible={visible.next}
                label={t('auth.changePassword.newLabel')}
                placeholder={t('auth.changePassword.newPlaceholder')}
                error={newError}
                errorId="change-password-new-error"
                descriptionId="change-password-new-description"
                autoComplete="new-password"
                minLength={NEW_PASSWORD_MIN_LENGTH}
                disabled={loading}
                onChange={(value) => {
                  setNewPassword(value);
                  setNewError('');
                  setFormError('');
                }}
                onToggle={() => toggleVisible('next')}
                showLabel={t('auth.changePassword.showPassword')}
                hideLabel={t('auth.changePassword.hidePassword')}
              />
              <p id="change-password-new-description" className="text-[12px] leading-5 text-[#858b9c]">
                {t('auth.changePassword.newDescription')}
              </p>
              {newError && (
                <p id="change-password-new-error" className="text-[12px] text-[#c43b3b]">
                  {newError}
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <label htmlFor="change-password-confirm" className="text-[13px] font-medium text-[#464c5e]">
                {t('auth.changePassword.confirmationLabel')}
              </label>
              <PasswordInput
                id="change-password-confirm"
                name="confirmation"
                ref={confirmationFieldRef}
                value={confirmation}
                visible={visible.confirm}
                label={t('auth.changePassword.confirmationLabel')}
                placeholder={t('auth.changePassword.confirmationPlaceholder')}
                error={confirmationError}
                errorId="change-password-confirm-error"
                autoComplete="new-password"
                disabled={loading}
                onChange={(value) => {
                  setConfirmation(value);
                  setConfirmationError('');
                  setFormError('');
                }}
                onToggle={() => toggleVisible('confirm')}
                showLabel={t('auth.changePassword.showPassword')}
                hideLabel={t('auth.changePassword.hidePassword')}
              />
              {confirmationError && (
                <p id="change-password-confirm-error" className="text-[12px] text-[#c43b3b]">
                  {confirmationError}
                </p>
              )}
            </div>

            {formError && (
              <div role="alert" className="rounded-[10px] border border-[#f2caca] bg-[#fff6f6] px-3 py-2.5 text-[13px] leading-5 text-[#a73535]">
                {formError}
              </div>
            )}

            <div className="mt-1 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={cancel}
                disabled={loading}
                className="h-11 rounded-[10px] border border-[#e3e7f1] px-5 text-[14px] text-[#464c5e] transition-colors hover:bg-[#f6f6f6] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#18181a]/30"
              >
                {t('auth.changePassword.cancel')}
              </button>
              <button
                type="submit"
                disabled={loading}
                className="h-11 rounded-[10px] bg-[#18181a] px-5 text-[14px] text-white transition-colors hover:bg-[#303238] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#18181a]/30"
              >
                {loading ? t('auth.changePassword.loading') : t('auth.changePassword.submit')}
              </button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}

type PasswordInputProps = {
  id: string;
  name: string;
  value: string;
  visible: boolean;
  label: string;
  placeholder: string;
  error: string;
  errorId: string;
  descriptionId?: string;
  autoComplete: string;
  minLength?: number;
  disabled: boolean;
  showLabel: string;
  hideLabel: string;
  onChange: (value: string) => void;
  onToggle: () => void;
};

const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  {
    id,
    name,
    value,
    visible,
    label,
    placeholder,
    error,
    errorId,
    descriptionId,
    autoComplete,
    minLength,
    disabled,
    showLabel,
    hideLabel,
    onChange,
    onToggle,
  },
  ref,
) {
  const describedBy = [descriptionId, error ? errorId : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <div className="relative">
      <input
        ref={ref}
        id={id}
        name={name}
        type={visible ? 'text' : 'password'}
        value={value}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-label={label}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={describedBy}
        minLength={minLength}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        className={`${INPUT_BASE_CLASS} ${error ? 'border-[#f54a45]' : ''} pr-11`}
      />
      <button
        type="button"
        aria-label={visible ? hideLabel : showLabel}
        aria-pressed={visible}
        onClick={onToggle}
        disabled={disabled}
        className="absolute inset-y-0 right-0 grid w-11 place-items-center text-[#7d879a] outline-none transition-colors hover:text-[#464c5e] disabled:cursor-not-allowed focus-visible:text-[#18181a]"
      >
        {visible ? (
          <IconFieldEyeOn className="size-[18px]" aria-hidden="true" />
        ) : (
          <IconFieldEye className="size-[18px]" aria-hidden="true" />
        )}
      </button>
    </div>
  );
});
