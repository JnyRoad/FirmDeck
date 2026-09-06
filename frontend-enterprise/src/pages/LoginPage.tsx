import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { api } from '../api/client';
import { setEnterpriseAuthSession, type EnterpriseAuthSession } from '../auth';
import AppHeader from '../components/AppHeader';
import BrandLogo from '../components/BrandLogo';
import IconFieldClear from '../assets/icons/field-clear.svg?react';
import IconFieldEye from '../assets/icons/field-eye.svg?react';
import IconFieldEyeOn from '../assets/icons/field-eye-on.svg?react';
import loginPreview from '../assets/firmdeck/login-preview.png';
import { useAppIntl } from '../i18n/useAppIntl';
import { RawIdentifier } from '../i18n/RawContent';

export type LoginPageProps = {
  onLogin: (session: EnterpriseAuthSession) => void;
};

/** 租户标识由服务端 Tenant.slug 定义；前端先做同一边界的格式校验，避免无效请求。 */
const TENANT_SLUG_PATTERN = /^(?=.{3,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const INPUT_BASE_CLASS =
  'flex h-[44px] w-full items-center gap-[8px] rounded-[10px] border bg-white px-[16px] transition-colors focus-within:border-[#18181a]';

/**
 * Signed-out landing / tenant login page. The tenant slug is deliberately
 * collected as user input so a deployment-wide tenant id can never silently
 * select the workspace for a login request.
 */
export default function LoginPage({ onLogin }: LoginPageProps) {
  const { t } = useAppIntl();
  const [showForm, setShowForm] = useState(false);
  const [tenantSlug, setTenantSlug] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [tenantError, setTenantError] = useState('');
  const [usernameError, setUsernameError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [requestError, setRequestError] = useState('');
  const [loading, setLoading] = useState(false);
  const tenantFieldRef = useRef<HTMLInputElement>(null);
  const usernameFieldRef = useRef<HTMLInputElement>(null);
  const passwordFieldRef = useRef<HTMLInputElement>(null);
  const openLoginButtonRef = useRef<HTMLButtonElement>(null);

  /** 打开表单后把键盘焦点放在第一步的租户标识，避免用户从页面中部开始寻找入口。 */
  useEffect(() => {
    if (showForm) tenantFieldRef.current?.focus();
  }, [showForm]);

  function clearRequestError() {
    if (requestError) setRequestError('');
  }

  function clearForm() {
    setTenantSlug('');
    setUsername('');
    setPassword('');
    setShowPassword(false);
    setTenantError('');
    setUsernameError('');
    setPasswordError('');
    setRequestError('');
  }

  function closeForm() {
    if (loading) return;
    clearForm();
    setShowForm(false);
    window.requestAnimationFrame(() => openLoginButtonRef.current?.focus());
  }

  /** 校验用户可见的租户 slug、账号和密码，并把第一个错误字段交还给键盘用户。 */
  function validate(): {
    tenant: string;
    username: string;
    valid: boolean;
  } {
    const normalizedTenantSlug = tenantSlug.trim();
    const normalizedUsername = username.trim();
    const nextTenantError = !normalizedTenantSlug
      ? t('auth.login.tenantRequired')
      : TENANT_SLUG_PATTERN.test(normalizedTenantSlug)
        ? ''
        : t('auth.login.tenantInvalid');
    const nextUsernameError = normalizedUsername ? '' : t('auth.login.usernameRequired');
    const nextPasswordError = password.length > 0 ? '' : t('auth.login.passwordRequired');

    setTenantError(nextTenantError);
    setUsernameError(nextUsernameError);
    setPasswordError(nextPasswordError);
    setRequestError('');

    if (nextTenantError) {
      tenantFieldRef.current?.focus();
    } else if (nextUsernameError) {
      usernameFieldRef.current?.focus();
    } else if (nextPasswordError) {
      passwordFieldRef.current?.focus();
    }

    return {
      tenant: normalizedTenantSlug,
      username: normalizedUsername,
      valid: !nextTenantError && !nextUsernameError && !nextPasswordError,
    };
  }

  /** 登录请求只提交用户输入的 tenant_slug；密码始终保持原始字节，不做 trim。 */
  async function login(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (loading) return;

    const validation = validate();
    if (!validation.valid) return;

    setLoading(true);
    try {
      const session = await api.post<EnterpriseAuthSession>('/api/auth/login', {
        tenant_slug: validation.tenant,
        username: validation.username,
        password,
      });
      setEnterpriseAuthSession(session);
      clearForm();
      onLogin(session);
    } catch {
      // 服务端、租户不存在和上游故障统一投影为同一安全文案，不回显错误体或凭据。
      setRequestError(t('auth.login.invalidCredentials'));
      setPassword('');
      setPasswordError('');
      setShowPassword(false);
    } finally {
      setLoading(false);
    }
  }

  /** Escape 取消当前输入并清空密码；Enter 交给 form submit，确保请求只发送一次。 */
  function onFormKeyDown(event: KeyboardEvent<HTMLFormElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeForm();
    }
  }

  const fieldErrorClass = (error: string, value: string) => (
    error ? 'border-[#f54a45]' : value ? 'border-[#18181a]' : 'border-[#e3e7f1]'
  );

  return (
    <div className="relative flex min-h-screen flex-col bg-white">
      <AppHeader
        className="h-[60px] shrink-0 px-[32px]"
        left={<BrandLogo markSize={28} />}
        right={null}
      />

      <main className="flex flex-1 flex-col items-center px-[32px]">
        <div className="flex w-full max-w-[1200px] flex-col items-center pt-[60px]">
          <span className="flex items-center justify-center rounded-[10px] border-[0.5px] border-[#e3e7f1] bg-[#f6f6f6] px-[20px] py-[6px] text-[14px] text-[#464c5e]">
            {t('auth.login.heroPrompt')}
          </span>
          <h1 className="mt-[6px] text-center text-[54px] font-semibold leading-[80px] tracking-[1.08px] text-[#18181a]">
            <RawIdentifier value="FirmDeck" />
            <br />
            {t('auth.login.productName')}
          </h1>

          {!showForm ? (
            <button
              ref={openLoginButtonRef}
              type="button"
              onClick={() => setShowForm(true)}
              className="mt-[24px] flex items-center justify-center rounded-[10px] bg-[#18181a] px-[36px] py-[10px] text-[16px] font-normal text-white transition-colors hover:bg-[#18181a]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#18181a]/30"
            >
              {t('auth.login.action')}
            </button>
          ) : (
            <form
              className="mt-[24px] flex w-full max-w-[360px] flex-col duration-300 ease-out animate-in fade-in slide-in-from-top-4"
              onSubmit={(event) => void login(event)}
              onKeyDown={onFormKeyDown}
              noValidate
              aria-busy={loading}
            >
              <div className="grid gap-[6px]">
                <label htmlFor="tenant-slug" className="sr-only">
                  {t('auth.login.tenantLabel')}
                </label>
                <div className={`${INPUT_BASE_CLASS} ${fieldErrorClass(tenantError, tenantSlug)}`}>
                  <input
                    ref={tenantFieldRef}
                    id="tenant-slug"
                    name="tenant_slug"
                    value={tenantSlug}
                    type="text"
                    autoFocus
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    minLength={3}
                    maxLength={63}
                    placeholder={t('auth.login.tenantPlaceholder')}
                    aria-label={t('auth.login.tenantLabel')}
                    aria-invalid={tenantError ? 'true' : undefined}
                    aria-describedby={tenantError ? 'tenant-slug-error' : 'tenant-slug-description'}
                    onChange={(event) => {
                      // Slugs are the only login field normalized in-place;
                      // username and password remain governed by their own
                      // exact-input contracts.
                      setTenantSlug(event.target.value.trim().toLowerCase());
                      setTenantError('');
                      clearRequestError();
                    }}
                    disabled={loading}
                    className="min-w-0 flex-1 border-0 bg-transparent text-[14px] lowercase text-[#18181a] outline-none placeholder:text-[#757f9c]"
                  />
                </div>
                <p id="tenant-slug-description" className="text-[12px] leading-5 text-[#858b9c]">
                  {t('auth.login.tenantDescription')}
                </p>
                {tenantError && (
                  <p id="tenant-slug-error" className="text-[12px] text-[#c43b3b]">
                    {tenantError}
                  </p>
                )}
              </div>

              <div className="mt-[18px] grid gap-[6px]">
                <label htmlFor="login-username" className="sr-only">
                  {t('auth.login.accountLabel')}
                </label>
                <div className={`${INPUT_BASE_CLASS} ${fieldErrorClass(usernameError, username)}`}>
                  <input
                    ref={usernameFieldRef}
                    id="login-username"
                    name="username"
                    value={username}
                    type="text"
                    autoComplete="username"
                    placeholder={t('auth.login.usernamePlaceholder')}
                    aria-label={t('auth.login.accountLabel')}
                    aria-invalid={usernameError ? 'true' : undefined}
                    aria-describedby={usernameError ? 'login-username-error' : undefined}
                    onChange={(event) => {
                      setUsername(event.target.value);
                      setUsernameError('');
                      clearRequestError();
                    }}
                    disabled={loading}
                    className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-[#18181a] outline-none placeholder:text-[#757f9c]"
                  />
                  {username && (
                    <button
                      type="button"
                      aria-label={t('auth.login.clearAccount')}
                      onClick={() => {
                        setUsername('');
                        setUsernameError('');
                        clearRequestError();
                        usernameFieldRef.current?.focus();
                      }}
                      disabled={loading}
                      className="grid size-[18px] shrink-0 place-items-center text-[#667085] outline-none transition-colors hover:text-[#464c5e] focus-visible:ring-2 focus-visible:ring-[#18181a]/30"
                    >
                      <IconFieldClear className="size-[18px]" aria-hidden="true" />
                    </button>
                  )}
                </div>
                {usernameError && (
                  <p id="login-username-error" className="text-[12px] text-[#c43b3b]">
                    {usernameError}
                  </p>
                )}
              </div>

              <div className="mt-[18px] grid gap-[6px]">
                <label htmlFor="login-password" className="sr-only">
                  {t('auth.login.passwordLabel')}
                </label>
                <div className={`${INPUT_BASE_CLASS} ${fieldErrorClass(passwordError, password)}`}>
                  <input
                    ref={passwordFieldRef}
                    id="login-password"
                    name="password"
                    value={password}
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder={t('auth.login.passwordPlaceholder')}
                    aria-label={t('auth.login.passwordLabel')}
                    aria-invalid={passwordError ? 'true' : undefined}
                    aria-describedby={passwordError ? 'login-password-error' : undefined}
                    onChange={(event) => {
                      setPassword(event.target.value);
                      setPasswordError('');
                      clearRequestError();
                    }}
                    disabled={loading}
                    className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-[#18181a] outline-none placeholder:text-[#757f9c]"
                  />
                  <button
                    type="button"
                    aria-label={showPassword
                      ? t('auth.login.hidePassword')
                      : t('auth.login.showPassword')}
                    aria-pressed={showPassword}
                    onClick={() => setShowPassword((prev) => !prev)}
                    disabled={loading}
                    className="grid size-[18px] shrink-0 place-items-center text-[#677185] outline-none transition-colors hover:text-[#464c5e] focus-visible:ring-2 focus-visible:ring-[#18181a]/30"
                  >
                    {showPassword ? (
                      <IconFieldEyeOn className="size-[18px]" aria-hidden="true" />
                    ) : (
                      <IconFieldEye className="size-[18px]" aria-hidden="true" />
                    )}
                  </button>
                </div>
                {passwordError && (
                  <p id="login-password-error" className="text-[12px] text-[#c43b3b]">
                    {passwordError}
                  </p>
                )}
              </div>

              {requestError && (
                <div role="alert" className="mt-[18px] rounded-[10px] border border-[#f2caca] bg-[#fff6f6] px-3 py-2.5 text-[13px] leading-5 text-[#a73535]">
                  {requestError}
                </div>
              )}

              <div className="mt-[24px] flex items-center justify-center gap-[10px]">
                <button
                  type="button"
                  onClick={closeForm}
                  disabled={loading}
                  className="flex h-[40px] min-w-[88px] items-center justify-center rounded-[10px] border border-[#e3e7f1] px-[18px] text-[14px] font-normal text-[#464c5e] transition-colors hover:bg-[#f6f6f6] disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#18181a]/30"
                >
                  {t('auth.login.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex h-[40px] min-w-[120px] items-center justify-center rounded-[10px] bg-[#18181a] px-[18px] text-[16px] font-normal text-white transition-colors hover:bg-[#18181a]/90 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#18181a]/30"
                >
                  {loading ? t('auth.login.loading') : t('auth.login.action')}
                </button>
              </div>
            </form>
          )}
        </div>

        <div className="mt-[32px] flex w-full justify-center">
          <img
            src={loginPreview}
            alt={t('auth.login.previewAlt')}
            className="h-auto w-full max-w-[1200px] select-none object-contain"
            draggable={false}
          />
        </div>
      </main>
    </div>
  );
}
