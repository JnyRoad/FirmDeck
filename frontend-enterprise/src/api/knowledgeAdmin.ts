/**
 * 知识库管理端（knowledge-base-admin）HTTP API 调用层。
 *
 * `pages/knowledge-admin/*` 访问知识库管理相关端点的唯一入口，内部包住
 * `createTenantClient` 发请求；不含缓存、重试等运行时逻辑，只负责按契约拼装
 * method/路径/query/body。函数与
 * specs/001-knowledge-base-admin/contracts/knowledge-admin-api.md 的
 * A1–A6（新增端点）与 B1–B5（既有端点变更）逐一对应；专用库既有端点复用
 * `KnowledgePage.tsx` / `TeamDetailPage.tsx` 中原内联调用的路径与方法，
 * 未在契约中列出的字段一律保持透传（`undefined` 由 `JSON.stringify` 丢弃，
 * 交由后端应用契约默认值）。
 */
import type { TenantSessionContextValue } from '@/contexts/TenantSessionContext';
import { KnowledgeBaseMode, VersionLevel } from '@/enums/knowledge';
import type {
  AgentProfileRead,
  CapabilityScope,
  KnowledgeBaseAuditPageRead,
  KnowledgeBaseConversionRead,
  KnowledgeBaseRead,
  KnowledgeBaseVersionRead,
  KnowledgeDocumentRead,
  KnowledgeIngestJobRead,
  TeamKnowledgeBindingRead,
  TeamKnowledgeGrantInput,
} from '@/types';
import type {
  KnowledgeAdminListItem,
  KnowledgeAdminListResponse,
  KnowledgeAdminTeamOption,
  KnowledgeAdminVersionRead,
  RebasePreview,
  RebaseResult,
  VersionDiff,
  VersionDocument,
} from '@/types/knowledgeAdmin';
import { createTenantClient, type TenantClient } from './tenant-client';

/** 把非空 query 值拼到路径后；`undefined`/`null`/`''` 一律跳过，不改写已有 query。 */
function appendQuery(
  path: string,
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    search.set(key, String(value));
  });
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

/** A1 `GET /knowledge-admin/knowledge-bases` 查询参数（`tenant_id` 由 tenant client 注入）。 */
export type ListKnowledgeBasesParams = {
  mode?: KnowledgeBaseMode;
  status?: 'active' | 'archived';
  ownerAgentId?: string;
  teamId?: string;
  q?: string;
  offset?: number;
  limit?: number;
};

/** A6 `GET /knowledge-admin/teams` 查询参数。 */
export type ListBindableTeamsParams = {
  excludeBoundTo?: string;
};

/** A2 `GET .../versions/{id}/diff` 查询参数。 */
export type GetVersionDiffOptions = {
  against?: 'base' | 'published';
  maxLines?: number;
};

/** A3 `POST .../versions/{id}/rebase` 请求体。 */
export type RebaseDraftBody = {
  changeReason: string;
  idempotencyKey?: string;
};

/** A4 冲突解决单篇文档：`lineage_id` 对应的完整合并结果。 */
export type RebaseResolution = {
  lineageId: string;
  contentMd: string;
};

/** A4 `POST .../versions/{id}/rebase/resolve` 请求体。 */
export type ResolveRebaseBody = {
  changeReason: string;
  idempotencyKey?: string;
  toBaseVersionId: string;
  resolutions: RebaseResolution[];
};

/** A5 `POST .../versions/{id}/review` 请求体。 */
export type RecordReviewBody = {
  staged: number;
  pending: number;
  documentsAdjusted: number;
  expectedUpdatedAt: string;
};

/** B1 `POST /knowledge-bases/{kb_id}/drafts` 请求体；`teamId=null` 表示租户管理员旁路创建。 */
export type CreateDraftBody = {
  teamId: string | null;
  changeReason: string;
  expectedPublishedVersionId?: string;
};

/** B1 `POST .../versions/{id}/publish` 请求体。 */
export type PublishDraftBody = {
  teamId: string | null;
  expectedPublishedVersionId: string;
  changeReason: string;
  level?: VersionLevel;
  forceOverwrite?: boolean;
  idempotencyKey?: string;
};

/** B1 `POST .../versions/{id}/reject` 请求体。 */
export type RejectDraftBody = {
  teamId: string | null;
  changeReason: string;
  idempotencyKey?: string;
};

/** B1 `POST /knowledge-bases/{kb_id}/rollback` 请求体（共享库：按 `target_version_id` 移动正式指针）。 */
export type RollbackVersionBody = {
  teamId: string | null;
  targetVersionId: string;
  expectedPublishedVersionId: string;
  changeReason: string;
  idempotencyKey?: string;
};

/**
 * B1 `rollback` 响应：正式指针移动结果（无独立契约类型，字段见 A/B 说明）。
 * 镜像 `backend/app/api/knowledge_bases.py` 中 `rollback_knowledge_base` 的共享库分支返回体。
 */
export type RollbackVersionResult = {
  status: string;
  knowledge_base_id: string;
  previous_published_version_id: string;
  target_version_id: string;
};

/**
 * B1 `POST /knowledge-bases/{kb_id}/rollback` 请求体（私有库：按 `version` 回滚员工分支头，
 * 对应后端 `KnowledgeBaseRollbackRequest`，不带 `team_id` 时判别式落到这一分支）。
 */
export type RollbackDedicatedBranchBody = {
  agentId: string;
  version: string;
};

/** 私有库 `rollback` 响应：镜像 `rollback_knowledge_base` 专用库分支的返回体。 */
export type RollbackDedicatedBranchResult = {
  status: string;
  knowledge_base_id: string;
  head_version: string;
};

/** 私有库 `sync-from-overall` / `promote-to-overall` 响应：镜像对应端点的返回体。 */
export type SyncFromOverallResult = {
  status: string;
  knowledge_base_id: string;
  head_version: string;
};

/** 见上：`promote-to-overall` 返回的是广场正式版本号，不是分支头。 */
export type PromoteToOverallResult = {
  status: string;
  knowledge_base_id: string;
  version: string;
};

/** B3 `POST /knowledge/documents` 请求体。 */
export type UploadDocumentBody = {
  knowledgeBaseId?: string;
  knowledgeBaseVersionId?: string;
  filename: string;
  contentBase64: string;
  title?: string;
  capabilityScope?: CapabilityScope;
  metadata?: Record<string, unknown>;
};

/** B3 `PUT /knowledge/documents/{id}` 请求体。 */
export type UpdateDocumentBody = {
  title?: string;
  status?: 'ready' | 'processing' | 'failed' | 'archived';
  metadata?: Record<string, unknown>;
  contentMd?: string;
  expectedUpdatedAt?: string;
};

/** B3 归档文档请求体：复用 `PUT` 文档接口，固定 `status=archived`。 */
export type ArchiveDocumentBody = {
  expectedUpdatedAt?: string;
};

/**
 * 既有端点复用：`POST /knowledge-bases`（无独立契约条目，路径/方法与
 * `KnowledgePage.tsx` 中 `createEmptyKnowledgeBase` 的内联调用一致）。
 * `mode='shared'` 时 `agentId` 必须省略，与后端 `KnowledgeBaseCreateRequest` 的
 * `validate_shared_has_no_employee_owner` 校验保持一致。
 */
export type CreateKnowledgeBaseBody = {
  name: string;
  description?: string;
  mode: KnowledgeBaseMode;
  agentId?: string;
  capabilityScope?: CapabilityScope;
};

/** 既有端点复用：`PUT /knowledge-bases/{kb_id}` 请求体。 */
export type UpdateKnowledgeBaseBody = {
  name?: string;
  description?: string;
  status?: 'active' | 'archived';
  capabilityScope?: CapabilityScope;
  metadata?: Record<string, unknown>;
};

/** 既有端点复用：绑定共享库到团队，二选一使用已有库或就地新建。 */
export type BindTeamBody = {
  isDefault?: boolean;
} & (
  | { existingKnowledgeBaseId: string; createShared?: undefined }
  | { createShared: { name: string }; existingKnowledgeBaseId?: undefined }
);

/** 既有端点复用：解绑 / 设默认绑定共用的乐观锁字段。 */
export type TeamBindingRevisionBody = {
  expectedRevision: number;
};

/** 既有端点复用：`PUT /teams/{team_id}/knowledge-bases/{kb_id}/grants` 请求体。 */
export type SaveGrantsBody = {
  expectedRevision: number;
  grants: TeamKnowledgeGrantInput[];
};

/** 既有端点复用：`GET /knowledge-bases/{kb_id}/audit-events` 查询参数。 */
export type ListAuditEventsParams = {
  offset?: number;
  limit?: number;
  teamId?: string;
  action?: string;
  actorType?: string;
  actorId?: string;
  versionId?: string;
};

/** 既有端点复用：`POST /knowledge-bases/{kb_id}/convert-to-shared` 请求体。 */
export type ConvertToSharedBody = {
  agentId: string;
  sourceVersionId?: string;
  name: string;
  description?: string;
  changeReason: string;
  teamBindings?: string[];
  defaultForTeamId?: string;
};

/** OKF lint 结果：无独立契约类型，镜像 `backend/app/api/knowledge_bases.py` 中 `lint_okf` 的返回体。 */
export type OkfLintResult = {
  status: string;
  issue_count: number;
  issues: unknown[];
};

/**
 * 创建知识库管理端 API 客户端；内部按需构造 `createTenantClient(tenantContext)`。
 * `client` 参数仅供测试注入 mock 客户端，业务代码不传第二个参数。
 */
export function createKnowledgeAdminApi(
  tenantContext: TenantSessionContextValue | null,
  client: TenantClient = createTenantClient(tenantContext),
) {
  return {
    /** A1 租户级知识库列表（admin）：按 mode/status/owner_agent_id/team_id/q 过滤，分页。 */
    listKnowledgeBases(params: ListKnowledgeBasesParams = {}): Promise<KnowledgeAdminListResponse> {
      return client.get(appendQuery('/api/enterprise/knowledge-admin/knowledge-bases', {
        mode: params.mode,
        status: params.status,
        owner_agent_id: params.ownerAgentId,
        team_id: params.teamId,
        q: params.q,
        offset: params.offset,
        limit: params.limit,
      }));
    },

    /**
     * Admin-first 单个知识库详情：`GET /knowledge-admin/knowledge-bases/{kb_id}`。
     * 与员工侧既有端点 `getKnowledgeBase` 不同，不需要 `agent_id` 即可读取共享 *和*
     * 专用知识库（管理员对租户内全部库可见），返回形状与 A1 列表项一致
     * （`KnowledgeAdminListItem`）。详情页 `load()` 用它替换原先的员工侧首次拉取，
     * 修复管理员打开共享/专用库详情因缺 `agent_id` 而 404（`KNOWLEDGE_BASE_VERSION_NOT_VISIBLE`）
     * 卡在 Loading 的缺陷。
     */
    getAdminKnowledgeBase(kbId: string): Promise<KnowledgeAdminListItem> {
      return client.get(`/api/enterprise/knowledge-admin/knowledge-bases/${kbId}`);
    },

    /** A6 可绑定群组候选（admin），供"绑定新群组"下拉使用。 */
    listBindableTeams(params: ListBindableTeamsParams = {}): Promise<KnowledgeAdminTeamOption[]> {
      return client.get(appendQuery('/api/enterprise/knowledge-admin/teams', {
        exclude_bound_to: params.excludeBoundTo,
      }));
    },

    /** 既有端点：租户全部员工列表，供"新建私有知识库"归属员工选择器使用（`AgentsPage.tsx` 同款调用）。 */
    listAgents(): Promise<AgentProfileRead[]> {
      return client.get('/api/enterprise/agents');
    },

    /** A2 版本对比：`against` 默认 `base`，超过 `max_lines` 的文档不含 `hunks`。 */
    getVersionDiff(
      kbId: string,
      versionId: string,
      options: GetVersionDiffOptions = {},
    ): Promise<VersionDiff> {
      return client.get(appendQuery(
        `/api/enterprise/knowledge-admin/knowledge-bases/${kbId}/versions/${versionId}/diff`,
        { against: options.against, max_lines: options.maxLines },
      ));
    },

    /**
     * A2b 版本文档全量列表（含未改动文档，真实行 `id`）：供写回（编辑/归档/恢复）
     * 定位当前版本内的正确行，而不是误用可能指向源文档的 `lineage_id`。
     */
    listVersionDocuments(kbId: string, versionId: string): Promise<VersionDocument[]> {
      return client.get(
        `/api/enterprise/knowledge-admin/knowledge-bases/${kbId}/versions/${versionId}/documents`,
      );
    },

    /** A3 变基预览 / 执行：无冲突直接落库返回 `RebaseResult`，有冲突返回 `RebasePreview` 不落库。 */
    rebaseDraft(
      kbId: string,
      versionId: string,
      body: RebaseDraftBody,
    ): Promise<RebasePreview | RebaseResult> {
      return client.post(
        `/api/enterprise/knowledge-admin/knowledge-bases/${kbId}/versions/${versionId}/rebase`,
        {
          change_reason: body.changeReason,
          idempotency_key: body.idempotencyKey,
        },
      );
    },

    /** A4 提交冲突解决并完成变基。 */
    resolveRebase(
      kbId: string,
      versionId: string,
      body: ResolveRebaseBody,
    ): Promise<RebaseResult> {
      return client.post(
        `/api/enterprise/knowledge-admin/knowledge-bases/${kbId}/versions/${versionId}/rebase/resolve`,
        {
          change_reason: body.changeReason,
          idempotency_key: body.idempotencyKey,
          to_base_version_id: body.toBaseVersionId,
          resolutions: body.resolutions.map((resolution) => ({
            lineage_id: resolution.lineageId,
            content_md: resolution.contentMd,
          })),
        },
      );
    },

    /** A5 写入审阅状态（`metadata.review`），触发审计 `draft_reviewed`。 */
    recordReview(
      kbId: string,
      versionId: string,
      body: RecordReviewBody,
    ): Promise<KnowledgeBaseVersionRead> {
      return client.post(
        `/api/enterprise/knowledge-admin/knowledge-bases/${kbId}/versions/${versionId}/review`,
        {
          staged: body.staged,
          pending: body.pending,
          documents_adjusted: body.documentsAdjusted,
          expected_updated_at: body.expectedUpdatedAt,
        },
      );
    },

    /** B1 由团队所有者或租户管理员（`teamId=null`）从当前正式版创建共享草稿。 */
    createDraft(kbId: string, body: CreateDraftBody): Promise<KnowledgeBaseVersionRead> {
      return client.post(`/api/enterprise/knowledge-bases/${kbId}/drafts`, {
        team_id: body.teamId,
        change_reason: body.changeReason,
        expected_published_version_id: body.expectedPublishedVersionId,
      });
    },

    /** B1 发布草稿为新正式版；`level`/`force_overwrite` 缺省时由后端套用契约默认值。 */
    publishDraft(
      kbId: string,
      versionId: string,
      body: PublishDraftBody,
    ): Promise<KnowledgeBaseVersionRead> {
      return client.post(`/api/enterprise/knowledge-bases/${kbId}/versions/${versionId}/publish`, {
        team_id: body.teamId,
        expected_published_version_id: body.expectedPublishedVersionId,
        change_reason: body.changeReason,
        level: body.level,
        force_overwrite: body.forceOverwrite,
        idempotency_key: body.idempotencyKey,
      });
    },

    /** B1 驳回共享草稿但保留快照与审计历史。 */
    rejectDraft(
      kbId: string,
      versionId: string,
      body: RejectDraftBody,
    ): Promise<KnowledgeBaseVersionRead> {
      return client.post(`/api/enterprise/knowledge-bases/${kbId}/versions/${versionId}/reject`, {
        team_id: body.teamId,
        change_reason: body.changeReason,
        idempotency_key: body.idempotencyKey,
      });
    },

    /** B1 共享库正式指针回滚到指定历史版本。 */
    rollbackVersion(kbId: string, body: RollbackVersionBody): Promise<RollbackVersionResult> {
      return client.post(`/api/enterprise/knowledge-bases/${kbId}/rollback`, {
        team_id: body.teamId,
        target_version_id: body.targetVersionId,
        expected_published_version_id: body.expectedPublishedVersionId,
        change_reason: body.changeReason,
        idempotency_key: body.idempotencyKey,
      });
    },

    /** B2 版本历史（含 `is_stale`/`base_version`/`draft_name`/`next_version_preview`）。 */
    listVersions(kbId: string, agentId?: string): Promise<KnowledgeAdminVersionRead[]> {
      return client.get(appendQuery(`/api/enterprise/knowledge-bases/${kbId}/versions`, {
        agent_id: agentId,
      }));
    },

    /** 既有端点：单篇文档详情（含 `metadata`），私有库内容 Tab 用于编辑前还原正文。 */
    getDocument(docId: string, agentId?: string): Promise<KnowledgeDocumentRead> {
      return client.get(appendQuery(`/api/enterprise/knowledge/documents/${docId}`, {
        agent_id: agentId,
      }));
    },

    /** 既有端点：私有库分支头从广场基线同步（`KnowledgePage.tsx` 内联调用同款路径）。 */
    syncFromOverall(kbId: string, agentId: string): Promise<SyncFromOverallResult> {
      return client.post(appendQuery(`/api/enterprise/knowledge-bases/${kbId}/sync-from-overall`, {
        agent_id: agentId,
      }));
    },

    /** 既有端点：把私有库分支头发布为广场模板正式版。 */
    promoteToOverall(kbId: string, agentId: string): Promise<PromoteToOverallResult> {
      return client.post(appendQuery(`/api/enterprise/knowledge-bases/${kbId}/promote-to-overall`, {
        agent_id: agentId,
      }));
    },

    /**
     * 私有库分支头回滚到历史版本；与共享库 `rollbackVersion` 共用同一后端路由，
     * 但请求体判别式不同（无 `team_id`，见 `RollbackDedicatedBranchBody` 注释）。
     */
    rollbackDedicatedBranch(kbId: string, body: RollbackDedicatedBranchBody): Promise<RollbackDedicatedBranchResult> {
      return client.post(`/api/enterprise/knowledge-bases/${kbId}/rollback`, {
        agent_id: body.agentId,
        version: body.version,
      });
    },

    /** B3 上传文档到专用分支或显式共享草稿（`knowledge_base_version_id` 必须为 draft）。 */
    uploadDocument(body: UploadDocumentBody, agentId?: string): Promise<KnowledgeIngestJobRead> {
      return client.post(appendQuery('/api/enterprise/knowledge/documents', { agent_id: agentId }), {
        knowledge_base_id: body.knowledgeBaseId,
        knowledge_base_version_id: body.knowledgeBaseVersionId,
        filename: body.filename,
        content_base64: body.contentBase64,
        title: body.title,
        capability_scope: body.capabilityScope,
        metadata: body.metadata,
      });
    },

    /** B3 更新专用文档或共享草稿文档；正式共享快照只读，由后端拒绝。 */
    updateDocument(
      docId: string,
      body: UpdateDocumentBody,
      agentId?: string,
    ): Promise<KnowledgeDocumentRead> {
      return client.put(appendQuery(`/api/enterprise/knowledge/documents/${docId}`, {
        agent_id: agentId,
      }), {
        title: body.title,
        status: body.status,
        metadata: body.metadata,
        content_md: body.contentMd,
        expected_updated_at: body.expectedUpdatedAt,
      });
    },

    /**
     * B3 归档文档：`backend/app/api/knowledge.py` 目前没有独立 DELETE/归档路由，
     * 复用 `PUT /knowledge/documents/{id}`（`update_document`），固定写入 `status: 'archived'`。
     */
    archiveDocument(
      docId: string,
      body: ArchiveDocumentBody = {},
      agentId?: string,
    ): Promise<KnowledgeDocumentRead> {
      return client.put(appendQuery(`/api/enterprise/knowledge/documents/${docId}`, {
        agent_id: agentId,
      }), {
        status: 'archived',
        expected_updated_at: body.expectedUpdatedAt,
      });
    },

    /** 既有端点：创建知识库（共享/私有），路径与方法复用 `KnowledgePage.tsx` 内联调用。 */
    createKnowledgeBase(body: CreateKnowledgeBaseBody): Promise<KnowledgeBaseRead> {
      return client.post('/api/enterprise/knowledge-bases', {
        name: body.name,
        description: body.description,
        mode: body.mode,
        agent_id: body.mode === KnowledgeBaseMode.Dedicated ? body.agentId : undefined,
        capability_scope: body.capabilityScope,
      });
    },

    /** 既有端点：读取单个知识库详情。 */
    getKnowledgeBase(kbId: string, agentId?: string): Promise<KnowledgeBaseRead> {
      return client.get(appendQuery(`/api/enterprise/knowledge-bases/${kbId}`, {
        agent_id: agentId,
      }));
    },

    /** 既有端点：更新知识库基础信息 / 状态。 */
    updateKnowledgeBase(
      kbId: string,
      body: UpdateKnowledgeBaseBody,
      agentId?: string,
    ): Promise<KnowledgeBaseRead> {
      return client.put(appendQuery(`/api/enterprise/knowledge-bases/${kbId}`, {
        agent_id: agentId,
      }), {
        name: body.name,
        description: body.description,
        status: body.status,
        capability_scope: body.capabilityScope,
        metadata: body.metadata,
      });
    },

    /** B4 删除知识库（管理员直接调用不带 `agent_id`）；共享库同事务清理绑定 / 授权 / 默认写入目标。 */
    deleteKnowledgeBase(kbId: string, agentId?: string): Promise<unknown> {
      return client.delete(appendQuery(`/api/enterprise/knowledge-bases/${kbId}`, {
        agent_id: agentId,
      }));
    },

    /** 既有端点：读取团队当前的共享知识库绑定列表。 */
    listTeamBindings(teamId: string): Promise<TeamKnowledgeBindingRead[]> {
      return client.get(`/api/enterprise/teams/${teamId}/knowledge-bases`);
    },

    /** 既有端点：把已有共享库绑定到团队，或就地新建共享库并绑定。 */
    bindTeam(teamId: string, body: BindTeamBody): Promise<TeamKnowledgeBindingRead> {
      return client.post(`/api/enterprise/teams/${teamId}/knowledge-bases`, {
        existing_knowledge_base_id: body.existingKnowledgeBaseId,
        create_shared: body.createShared,
        is_default: body.isDefault,
      });
    },

    /** 既有端点：撤销团队对某共享库的绑定（乐观锁 `expected_revision`）。 */
    unbindTeam(teamId: string, kbId: string, body: TeamBindingRevisionBody): Promise<unknown> {
      return client.delete(`/api/enterprise/teams/${teamId}/knowledge-bases/${kbId}`, {
        expected_revision: body.expectedRevision,
      });
    },

    /** 既有端点：把团队默认写入目标切换到指定已绑定共享库。 */
    setDefaultBinding(
      teamId: string,
      kbId: string,
      body: TeamBindingRevisionBody,
    ): Promise<TeamKnowledgeBindingRead> {
      return client.put(`/api/enterprise/teams/${teamId}/knowledge-bases/${kbId}`, {
        expected_revision: body.expectedRevision,
        is_default: true,
      });
    },

    /** B5 全量原子替换一个共享库在团队内的成员权限矩阵。 */
    saveGrants(teamId: string, kbId: string, body: SaveGrantsBody): Promise<TeamKnowledgeBindingRead> {
      return client.put(`/api/enterprise/teams/${teamId}/knowledge-bases/${kbId}/grants`, {
        expected_revision: body.expectedRevision,
        grants: body.grants,
      });
    },

    /** 既有端点：分页读取共享知识库审计事件，支持团队 / 动作 / 操作者 / 版本过滤。 */
    listAuditEvents(
      kbId: string,
      params: ListAuditEventsParams = {},
    ): Promise<KnowledgeBaseAuditPageRead> {
      return client.get(appendQuery(`/api/enterprise/knowledge-bases/${kbId}/audit-events`, {
        offset: params.offset,
        limit: params.limit,
        team_id: params.teamId,
        action: params.action,
        actor_type: params.actorType,
        actor_id: params.actorId,
        version_id: params.versionId,
      }));
    },

    /** 既有端点：导出当前可见版本的 OKF 备份包（zip blob）。 */
    exportOkf(kbId: string, agentId?: string): Promise<Blob> {
      return client.blob(appendQuery(`/api/enterprise/knowledge-bases/${kbId}/okf/export`, {
        agent_id: agentId,
      }));
    },

    /** 既有端点：对当前可见版本的 OKF 概念图跑一致性 lint。 */
    lintOkf(kbId: string, agentId?: string): Promise<OkfLintResult> {
      return client.post(appendQuery(`/api/enterprise/knowledge-bases/${kbId}/okf/lint`, {
        agent_id: agentId,
      }));
    },

    /** 既有端点：把专用分支原子转换为新的共享知识库，可选带初始团队绑定。 */
    convertToShared(kbId: string, body: ConvertToSharedBody): Promise<KnowledgeBaseConversionRead> {
      return client.post(`/api/enterprise/knowledge-bases/${kbId}/convert-to-shared`, {
        agent_id: body.agentId,
        source_version_id: body.sourceVersionId,
        name: body.name,
        description: body.description,
        change_reason: body.changeReason,
        team_bindings: body.teamBindings,
        default_for_team_id: body.defaultForTeamId,
      });
    },
  };
}

/** `createKnowledgeAdminApi` 返回的完整客户端形状，供页面层类型标注使用。 */
export type KnowledgeAdminApi = ReturnType<typeof createKnowledgeAdminApi>;
