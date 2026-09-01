/**
 * 为已验证的租户和用户生成浏览器存储命名空间；任何身份缺失或非字符串值都拒绝生成键。
 * 这里保留原始标识的大小写和 Unicode 内容，并用 JSON 数组编码避免分隔符碰撞。
 */

export const TENANT_USER_STORAGE_PREFIX = 'skill_agent:tenant-user:v1';

/**
 * 校验存储命名空间的一段原始身份；返回值不做大小写、locale 或空白归一化。
 * 无副作用；输入不是非空字符串时抛出 TypeError，使调用方 fail closed。
 */
function requireStorageIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`Invalid tenant storage ${field}`);
  }
  return value;
}

/**
 * 生成稳定的租户/用户/功能键；返回的键只属于通过显式身份校验的命名空间。
 * 不读写浏览器存储，也不会迁移或读取任何旧的无租户键。
 */
export function tenantUserStorageKey(
  tenantId: unknown,
  userId: unknown,
  feature: unknown,
): string {
  const identity = [
    requireStorageIdentity(tenantId, 'tenant identity'),
    requireStorageIdentity(userId, 'user identity'),
    requireStorageIdentity(feature, 'feature identity'),
  ];
  return `${TENANT_USER_STORAGE_PREFIX}:${JSON.stringify(identity)}`;
}

/**
 * 判断一个键是否来自租户/用户命名空间；仅作本地格式门禁，不解析或恢复旧键。
 * 无副作用；未知值和旧的无租户键均返回 false。
 */
export function isTenantUserStorageKey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const encodedIdentity = value.slice(`${TENANT_USER_STORAGE_PREFIX}:`.length);
  if (!value.startsWith(`${TENANT_USER_STORAGE_PREFIX}:`) || !encodedIdentity) return false;
  try {
    const identity = JSON.parse(encodedIdentity) as unknown;
    return Array.isArray(identity)
      && identity.length === 3
      && identity.every((part) => typeof part === 'string' && part.trim().length > 0);
  } catch {
    return false;
  }
}
