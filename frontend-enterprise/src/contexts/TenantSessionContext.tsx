import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import {
  clearEnterpriseAuthSession,
  parseEnterpriseAuthSession,
  parseEnterpriseAuthUser,
  setEnterpriseAuthSession,
  type EnterpriseAuthSession,
  type EnterpriseAuthUser,
} from '../auth';
import { API_BASE } from '../api/client';

export type TenantSessionContextValue = {
  /** The server-verified tenant session currently bound to this tree. */
  session: EnterpriseAuthSession;
  tenantId: string;
  tenantSlug: string;
  userId: string;
  /** Opaque monotonically increasing fence for requests in this scope. */
  generation: number;
  /** Aborted whenever this provider leaves the current tenant generation. */
  signal: AbortSignal;
  /** Re-check a captured generation before publishing asynchronous results. */
  isCurrentGeneration(generation: number): boolean;
};

export type TenantSessionProviderProps = {
  session: EnterpriseAuthSession | null;
  children: ReactNode;
  onInvalidSession?: () => void;
};

export type TenantSessionVerificationError = 'network' | 'server' | 'malformed-response';

export type TenantSessionVerificationState = {
  status: 'idle' | 'verifying' | 'ready' | 'invalid' | 'error';
  error: TenantSessionVerificationError | null;
  /** Retry the current bearer verification without changing tenant scope. */
  retry(): void;
};

const TenantSessionContext = createContext<TenantSessionContextValue | null>(null);
const TenantSessionVerificationContext = createContext<TenantSessionVerificationState>({
  status: 'idle',
  error: null,
  retry: () => {},
});

/**
 * Verify a tenant bearer before making tenant identity available to children.
 *
 * The effect owns both the generation fence and its root abort controller. A
 * replacement therefore clears the context synchronously at the effect
 * boundary and prevents a late `/me` response from crossing tenant scopes.
 */
export function TenantSessionProvider({
  session,
  children,
  onInvalidSession,
}: TenantSessionProviderProps) {
  const [value, setValue] = useState<TenantSessionContextValue | null>(null);
  const [verificationState, setVerificationState] = useState<
    Omit<TenantSessionVerificationState, 'retry'>
  >({ status: 'idle', error: null });
  const [retryRevision, setRetryRevision] = useState(0);
  const generationRef = useRef(0);
  const rootControllerRef = useRef<AbortController | null>(null);
  const invalidSessionHandlerRef = useRef(onInvalidSession);

  // Keep callback changes from restarting verification or creating a new
  // generation. The callback is still current when a request becomes invalid.
  invalidSessionHandlerRef.current = onInvalidSession;

  const retry = useCallback(() => {
    setRetryRevision((revision) => revision + 1);
  }, []);
  const verificationContextValue = useMemo(
    () => ({ ...verificationState, retry }),
    [retry, verificationState],
  );

  useEffect(() => {
    const previousController = rootControllerRef.current;
    previousController?.abort();

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const controller = new AbortController();
    rootControllerRef.current = controller;
    setValue(null);
    setVerificationState({ status: session ? 'verifying' : 'idle', error: null });

    const isCurrent = () => (
      generationRef.current === generation && !controller.signal.aborted
    );

    if (!session) {
      return () => {
        if (generationRef.current !== generation) return;
        generationRef.current += 1;
        controller.abort();
        if (rootControllerRef.current === controller) rootControllerRef.current = null;
        setValue(null);
      };
    }

    const parsedSession = parseEnterpriseAuthSession(session);

    const invalidate = () => {
      if (!isCurrent()) return;
      setVerificationState({ status: 'invalid', error: null });
      clearEnterpriseAuthSession();
      setValue(null);
      invalidSessionHandlerRef.current?.();
    };

    if (!parsedSession) {
      invalidate();
      return () => {
        if (generationRef.current !== generation) return;
        generationRef.current += 1;
        controller.abort();
        if (rootControllerRef.current === controller) rootControllerRef.current = null;
        setValue(null);
      };
    }

    let settled = false;
    const verify = async (): Promise<
      | { kind: 'verified'; user: EnterpriseAuthUser }
      | { kind: 'invalid' }
      | { kind: 'transient'; error: TenantSessionVerificationError }
    > => {
      const response = await fetch(`${API_BASE}/api/auth/me`, {
        headers: { Authorization: `Bearer ${parsedSession.token}` },
        signal: controller.signal,
      });
      if (!response.ok) {
        return response.status === 401 || response.status === 403
          ? { kind: 'invalid' }
          : { kind: 'transient', error: 'server' };
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return { kind: 'transient', error: 'malformed-response' };
      }

      const verifiedUser = parseEnterpriseAuthUser(payload);
      if (!verifiedUser) return { kind: 'transient', error: 'malformed-response' };
      if (verifiedUser.tenant_id !== parsedSession.tenant.id) return { kind: 'invalid' };
      if (verifiedUser.id !== parsedSession.user.id) return { kind: 'invalid' };
      return { kind: 'verified', user: verifiedUser };
    };

    void verify()
      .then((result) => {
        if (!isCurrent()) return;
        settled = true;
        if (result.kind === 'invalid') {
          invalidate();
          return;
        }
        if (result.kind === 'transient') {
          setVerificationState({ status: 'error', error: result.error });
          setValue(null);
          return;
        }

        const verifiedSession: EnterpriseAuthSession = {
          ...parsedSession,
          user: result.user,
        };
        // The response is authoritative for mutable policy fields such as
        // must_change_password. A storage failure must not turn a valid
        // server verification into a cross-tenant context.
        try {
          setEnterpriseAuthSession(verifiedSession);
        } catch {
          // The verified in-memory context remains usable; the next reload
          // will retry persistence and re-verify the bearer.
        }

        setVerificationState({ status: 'ready', error: null });
        setValue({
          session: verifiedSession,
          tenantId: verifiedSession.tenant.id,
          tenantSlug: verifiedSession.tenant.slug,
          userId: verifiedSession.user.id,
          generation,
          signal: controller.signal,
          isCurrentGeneration: (candidate) => (
            generationRef.current === candidate
            && !controller.signal.aborted
          ),
        });
      })
      .catch(() => {
        if (!isCurrent()) return;
        settled = true;
        setVerificationState({ status: 'error', error: 'network' });
        setValue(null);
      });

    return () => {
      if (generationRef.current !== generation) return;
      generationRef.current += 1;
      controller.abort();
      if (rootControllerRef.current === controller) rootControllerRef.current = null;
      // A cleanup can run before a replacement effect; never expose the old
      // verified tenant while the next session is still being checked.
      setValue(null);
      void settled;
    };
  }, [retryRevision, session]);

  return (
    <TenantSessionVerificationContext.Provider value={verificationContextValue}>
      <TenantSessionContext.Provider value={value}>
        {children}
      </TenantSessionContext.Provider>
    </TenantSessionVerificationContext.Provider>
  );
}

export function useTenantSession(): TenantSessionContextValue | null {
  return useContext(TenantSessionContext);
}

export function useTenantSessionVerification(): TenantSessionVerificationState {
  return useContext(TenantSessionVerificationContext);
}

export type { EnterpriseAuthUser };
