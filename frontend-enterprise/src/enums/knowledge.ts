/**
 * 知识库管理端（knowledge-base-admin）枚举集中定义。
 *
 * 取值对应 specs/001-knowledge-base-admin/data-model.md 与
 * contracts/knowledge-admin-api.md 中知识库模式、版本发布状态、团队权限与版本
 * 递进级别的既有取值约定，避免业务代码中散落魔法字符串。
 */

/** 知识库类型：`shared` 为跨团队绑定的共享库，`dedicated` 为归属单个数字员工的私有库。 */
export enum KnowledgeBaseMode {
  Shared = 'shared',
  Dedicated = 'dedicated',
}

/** 知识库版本的发布状态：草稿、已发布（正式版）、已驳回。 */
export enum PublicationState {
  Draft = 'draft',
  Released = 'released',
  Rejected = 'rejected',
}

/**
 * 团队（或成员）对知识库的权限级别，只读 / 可编辑 / 可发布，权限递进。
 * 取值与 `@/types` 中既有的 `KnowledgePermission` 类型别名字面量兼容；
 * 新代码优先使用本枚举以获得集中定义与自动补全。
 */
export enum KnowledgePermission {
  Reader = 'reader',
  Editor = 'editor',
  Publisher = 'publisher',
}

/** 发布草稿时选择的版本递进级别，对应 semver 的 patch / minor / major。 */
export enum VersionLevel {
  Patch = 'patch',
  Minor = 'minor',
  Major = 'major',
}
