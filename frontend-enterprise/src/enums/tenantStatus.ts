export const TENANT_STATUS = {
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  UNKNOWN: 'unknown',
} as const;

export type TenantStatus = typeof TENANT_STATUS.ACTIVE | typeof TENANT_STATUS.SUSPENDED;
export type TenantDisplayStatus = TenantStatus | typeof TENANT_STATUS.UNKNOWN;

export function isTenantStatus(value: unknown): value is TenantStatus {
  return value === TENANT_STATUS.ACTIVE || value === TENANT_STATUS.SUSPENDED;
}
