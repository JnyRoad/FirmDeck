import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

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

const TenantSessionContext = createContext<TenantSessionContextValue | null>(null);

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
  const generationRef = useRef(0);
  const rootControllerRef = useRef<AbortController | null>(null);
  const invalidSessionHandlerRef = useRef(onInvalidSession);

  // Keep callback changes from restarting verification or creating a new
  // generation. The callback is still current when a request becomes invalid.
  invalidSessionHandlerRef.current = onInvalidSession;

  useEffect(() => {
    const previousController = rootControllerRef.current;
    previousController?.abort();

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const controller = new AbortController();
    rootControllerRef.current = controller;
    setValue(null);

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
    const verify = async () => {
      const response = await fetch(`${API_BASE}/api/auth/me`, {
        headers: { Authorization: `Bearer ${parsedSession.token}` },
        signal: controller.signal,
      });
      if (!response.ok) return null;

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        return null;
      }

      const verifiedUser = parseEnterpriseAuthUser(payload);
      if (!verifiedUser) return null;
      if (verifiedUser.tenant_id !== parsedSession.tenant.id) return null;
      if (verifiedUser.id !== parsedSession.user.id) return null;
      return verifiedUser;
    };

    void verify()
      .then((verifiedUser) => {
        if (!isCurrent()) return;
        settled = true;
        if (!verifiedUser) {
          invalidate();
          return;
        }

        const verifiedSession: EnterpriseAuthSession = {
          ...parsedSession,
          user: verifiedUser,
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
        invalidate();
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
  }, [session]);

  return (
    <TenantSessionContext.Provider value={value}>
      {children}
    </TenantSessionContext.Provider>
  );
}

export function useTenantSession(): TenantSessionContextValue | null {
  return useContext(TenantSessionContext);
}

export type { EnterpriseAuthUser };
