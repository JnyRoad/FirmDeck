from __future__ import annotations

from datetime import datetime
from typing import Annotated, Any, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator
from typing_extensions import TypedDict

from app.capability_scope import CapabilityScope

KnowledgeBaseMode = Literal["dedicated", "shared"]
KnowledgePublicationState = Literal["draft", "released", "rejected"]
NonEmptyText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class KnowledgeErrorDescriptor(TypedDict):
    """持久化知识任务对外暴露的稳定错误字段，不包含异常原文。"""

    code: str
    params: dict[str, Any]
    retryable: bool
    request_id: str | None
    trace_id: str | None


class KnowledgeStageDescriptor(TypedDict):
    """知识入库阶段的稳定代码和具名参数，显示文案由客户端语言决定。"""

    code: str
    params: dict[str, Any]


class KnowledgeIngestStep(TypedDict):
    """知识入库进度条使用的机器阶段数据，不携带已翻译标签。"""

    key: str
    code: str
    params: dict[str, Any]
    progress: float
    status: Literal["pending", "running", "done"]


class KnowledgeTraceItem(TypedDict, total=False):
    """检索诊断步骤的稳定代码、参数和受控统计字段。"""

    phase: str
    code: str
    params: dict[str, Any]
    candidate_count: int
    selected_count: int
    section_count: int
    chunk_count: int
    evidence_count: int
    mode: str
    selected_document_ids: list[str]


class KnowledgeBaseCreateRequest(BaseModel):
    tenant_id: str
    name: str
    description: Optional[str] = None
    mode: KnowledgeBaseMode = "dedicated"
    agent_id: str | None = None
    capability_scope: CapabilityScope = "general"
    metadata: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_shared_has_no_employee_owner(self) -> KnowledgeBaseCreateRequest:
        """共享知识库属于团队绑定关系，不能同时声明员工私有所有者。"""
        if self.mode == "shared" and self.agent_id:
            raise ValueError("shared knowledge base cannot declare agent_id")
        return self


class KnowledgeBaseUpdateRequest(BaseModel):
    tenant_id: str
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[Literal["active", "archived"]] = None
    capability_scope: Optional[CapabilityScope] = None
    metadata: Optional[dict[str, Any]] = None


class KnowledgeBaseRollbackRequest(BaseModel):
    tenant_id: str
    agent_id: str
    version: str


class KnowledgeBaseRead(BaseModel):
    id: str
    tenant_id: str
    name: str
    description: Optional[str] = None
    status: str
    mode: KnowledgeBaseMode = "dedicated"
    published_version_id: str | None = None
    published_version: str | None = None
    bound_team_count: int = 0
    management_context: dict[str, Any] = Field(default_factory=dict)
    capability_scope: CapabilityScope
    version: Optional[str] = None
    branch_sync_state: Optional[str] = None
    branch_base_version: Optional[str] = None
    branch_head_version: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    document_count: int = 0
    bucket_count: int = 0
    chunk_count: int = 0
    created_at: str
    updated_at: str

    model_config = ConfigDict(from_attributes=True)


class KnowledgeBaseVersionRead(BaseModel):
    id: str
    tenant_id: str
    knowledge_base_id: str
    version: str
    name: str
    description: str | None = None
    status: str
    publication_state: KnowledgePublicationState
    parent_version_id: str | None = None
    source_team_id: str | None = None
    created_by_agent_id: str | None = None
    created_by_user_id: str | None = None
    change_reason: str | None = None
    published_at: datetime | None = None
    is_published_head: bool = False
    is_stale: bool = False
    base_version: str | None = None
    draft_name: str | None = None
    next_version_preview: dict[str, str] | None = None
    capability_scope: CapabilityScope = "general"
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class KnowledgeAdminOwnerAgentRead(BaseModel):
    """A1 列表项的 owner_agent：私有库归属员工。"""

    id: str
    name: str


class KnowledgeAdminBoundTeamRead(BaseModel):
    """A1 列表项 bound_teams 的一条团队绑定，is_default 标记团队默认库。"""

    id: str
    name: str
    is_default: bool


class KnowledgeAdminBranchRead(BaseModel):
    """A1 列表项的 branch：仅私有库存在，取 owner 员工分支的基线/头版本与同步状态。"""

    base_version: str
    head_version: str
    sync_state: str


class KnowledgeAdminListItem(BaseModel):
    """A1 `GET /knowledge-admin/knowledge-bases` 的 items[] 元素。"""

    id: str
    name: str
    description: str | None = None
    mode: KnowledgeBaseMode
    status: Literal["active", "archived"]
    capability_scope: CapabilityScope
    published_version: str | None = None
    published_version_id: str | None = None
    draft_count: int = 0
    document_count: int = 0
    owner_agent: KnowledgeAdminOwnerAgentRead | None = None
    bound_teams: list[KnowledgeAdminBoundTeamRead] = Field(default_factory=list)
    branch: KnowledgeAdminBranchRead | None = None
    updated_at: str


class KnowledgeAdminListSummary(BaseModel):
    """A1 响应的 summary：全租户统计，不受过滤参数影响。"""

    total: int
    shared: int
    dedicated: int
    documents: int


class KnowledgeAdminListResponse(BaseModel):
    """A1 分页响应：`GET /knowledge-admin/knowledge-bases`。"""

    items: list[KnowledgeAdminListItem] = Field(default_factory=list)
    summary: KnowledgeAdminListSummary
    total: int
    offset: int
    limit: int
    has_more: bool


class KnowledgeAdminTeamOption(BaseModel):
    """A6 `GET /knowledge-admin/teams` 的候选团队条目。"""

    id: str
    name: str
    member_count: int


class KnowledgeBaseAuditEventRead(BaseModel):
    id: str
    knowledge_base_id: str
    team_id: str | None = None
    team_name: str | None = None
    knowledge_base_version_id: str | None = None
    knowledge_base_version: str | None = None
    actor_type: str
    actor_id: str
    actor_name: str
    action: str
    reason: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)
    created_at: datetime


class KnowledgeBaseAuditPageRead(BaseModel):
    items: list[KnowledgeBaseAuditEventRead] = Field(default_factory=list)
    total: int
    offset: int
    limit: int
    has_more: bool


class SharedKnowledgeTeamRead(BaseModel):
    """一个当前用户可管理且已绑定共享知识库的活动团队。"""

    id: str
    name: str


class SharedKnowledgeDraftCreateRequest(BaseModel):
    tenant_id: str
    # team_id 为空时要求调用者是租户管理员（require_team_knowledge_manager 旁路），
    # 用于治理未绑定任何团队的共享库。
    team_id: str | None = None
    change_reason: NonEmptyText
    expected_published_version_id: str | None = None


class SharedKnowledgePublishRequest(BaseModel):
    tenant_id: str
    team_id: str | None = None
    expected_published_version_id: NonEmptyText
    change_reason: NonEmptyText
    # 保持 str 而非 Literal：非法值必须经由领域校验映射为
    # KNOWLEDGE_VERSION_LEVEL_INVALID（400, params.level），而不是被 Pydantic
    # 在到达路由前拒绝并折叠成通用 VALIDATION_ERROR（422）。
    level: str = "patch"
    force_overwrite: bool = False
    idempotency_key: str | None = None


class SharedKnowledgeRejectRequest(BaseModel):
    tenant_id: str
    team_id: str | None = None
    change_reason: NonEmptyText
    idempotency_key: str | None = None


class SharedKnowledgeRollbackRequest(BaseModel):
    tenant_id: str
    team_id: str | None = None
    target_version_id: NonEmptyText
    expected_published_version_id: NonEmptyText
    change_reason: NonEmptyText
    idempotency_key: str | None = None


class KnowledgeBaseConvertToSharedRequest(BaseModel):
    tenant_id: str
    agent_id: NonEmptyText
    source_version_id: str | None = None
    name: NonEmptyText
    description: str | None = None
    change_reason: NonEmptyText
    team_bindings: list[str] = Field(default_factory=list)
    default_for_team_id: str | None = None

    @model_validator(mode="after")
    def validate_initial_team_bindings(self) -> KnowledgeBaseConvertToSharedRequest:
        """初始绑定不得重复，且默认团队必须属于同一批绑定。"""
        if len(set(self.team_bindings)) != len(self.team_bindings):
            raise ValueError("team_bindings must be unique")
        if self.default_for_team_id and self.default_for_team_id not in self.team_bindings:
            raise ValueError("default_for_team_id must be included in team_bindings")
        return self


class KnowledgeBaseConversionRead(BaseModel):
    source_knowledge_base_id: str
    source_version_id: str
    new_knowledge_base: KnowledgeBaseRead
    released_version: KnowledgeBaseVersionRead
    binding_ids: list[str] = Field(default_factory=list)
    default_for_team_id: str | None = None
    source_archived: bool
    audit_event_id: str


class KnowledgeDocumentUploadRequest(BaseModel):
    tenant_id: str
    knowledge_base_id: Optional[str] = None
    knowledge_base_version_id: str | None = None
    filename: str
    content_base64: str
    title: Optional[str] = None
    capability_scope: CapabilityScope = "general"
    metadata: dict[str, Any] = Field(default_factory=dict)


class KnowledgeIngestJobRead(BaseModel):
    id: str
    tenant_id: str
    tenant_lifecycle_version: int = 1
    knowledge_base_id: str
    document_id: Optional[str] = None
    filename: str
    status: str
    stage: str
    progress: float
    error: KnowledgeErrorDescriptor | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    updated_at: str

    model_config = ConfigDict(from_attributes=True)


class KnowledgeDocumentRead(BaseModel):
    id: str
    tenant_id: str
    knowledge_base_id: str
    knowledge_base_version_id: str | None = None
    filename: str
    file_type: str
    title: Optional[str] = None
    status: str
    bucket_count: int
    chunk_count: int
    metadata: dict[str, Any] = Field(default_factory=dict)
    error: KnowledgeErrorDescriptor | None = None
    created_at: str
    updated_at: str

    model_config = ConfigDict(from_attributes=True)


class KnowledgeDocumentUpdateRequest(BaseModel):
    tenant_id: str
    title: Optional[str] = None
    status: Optional[Literal["ready", "processing", "failed", "archived"]] = None
    metadata: Optional[dict[str, Any]] = None
    content_md: Optional[str] = Field(default=None, max_length=2_000_000)
    expected_updated_at: Optional[str] = None


class KnowledgeBucketRead(BaseModel):
    id: str
    tenant_id: str
    knowledge_base_id: str
    document_id: str
    bucket_key: str
    title: str
    summary: str
    token_estimate: int
    chunk_count: int = 0
    status: str = "ready"
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    updated_at: str

    model_config = ConfigDict(from_attributes=True)


class KnowledgeBucketUpdateRequest(BaseModel):
    tenant_id: str
    title: Optional[str] = None
    summary: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None


class KnowledgeChunkRead(BaseModel):
    id: str
    tenant_id: str
    knowledge_base_id: str
    document_id: str
    bucket_id: str
    chunk_index: int
    content: str
    summary: Optional[str] = None
    source_ref: Optional[str] = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    created_at: str
    updated_at: str

    model_config = ConfigDict(from_attributes=True)


class KnowledgeChunkUpdateRequest(BaseModel):
    tenant_id: str
    content: Optional[str] = None
    summary: Optional[str] = None
    metadata: Optional[dict[str, Any]] = None


class KnowledgeConceptRead(BaseModel):
    id: str
    tenant_id: str
    knowledge_base_id: str
    knowledge_base_version_id: Optional[str] = None
    document_id: Optional[str] = None
    concept_id: str
    concept_type: str
    title: str
    description: Optional[str] = None
    content_md: str
    frontmatter: dict[str, Any] = Field(default_factory=dict)
    links: list[dict[str, Any]] = Field(default_factory=list)
    citations: list[dict[str, Any]] = Field(default_factory=list)
    source_refs: list[dict[str, Any]] = Field(default_factory=list)
    status: str
    created_at: str
    updated_at: str

    model_config = ConfigDict(from_attributes=True)


class KnowledgeConceptUpdateRequest(BaseModel):
    tenant_id: str
    content_md: str
    document_id: Optional[str] = None
    status: Literal["active", "archived"] = "active"


class KnowledgeOkfImportRequest(BaseModel):
    tenant_id: str
    knowledge_base_id: Optional[str] = None
    knowledge_base_version_id: str | None = None
    filename: str
    content_base64: str
    agent_id: Optional[str] = None


class KnowledgeSearchRequest(BaseModel):
    tenant_id: str
    agent_id: Optional[str] = None
    query: str
    query_type: Literal["answer", "policy_check", "tool_discovery", "skill_discovery"] = "answer"
    desired_evidence: Optional[str] = None
    scope: dict[str, Any] = Field(default_factory=dict)
    model_config_id: Optional[str] = None
    mode: Literal["chat", "skill_discovery", "debug"] = "chat"
    knowledge_base_ids: list[str] = Field(default_factory=list)
    knowledge_base_version_ids: list[str] = Field(default_factory=list)
    document_ids: list[str] = Field(default_factory=list)
    max_bucket_rounds: int = 2
    max_buckets: int = 4
    max_chunks: int = 8
    budget_tokens: int = 4000
    max_depth: int = 2
    need_evidence_pack: bool = True


class KnowledgeSearchResponse(BaseModel):
    selected_buckets: list[KnowledgeBucketRead] = Field(default_factory=list)
    chunks: list[KnowledgeChunkRead] = Field(default_factory=list)
    trace: list[KnowledgeTraceItem] = Field(default_factory=list)
    route_trace: list[KnowledgeTraceItem] = Field(default_factory=list)
    selected_documents: list[dict[str, Any]] = Field(default_factory=list)
    selected_concepts: list[dict[str, Any]] = Field(default_factory=list)
    expanded_sections: list[dict[str, Any]] = Field(default_factory=list)
    okf_citations: list[dict[str, Any]] = Field(default_factory=list)
    evidence_pack: list[dict[str, Any]] = Field(default_factory=list)


class KnowledgeDiscoveryRead(BaseModel):
    id: str
    tenant_id: str
    knowledge_base_id: str
    document_id: str
    bucket_id: Optional[str] = None
    suggestion_type: Literal["skill", "tool", "warning"]
    title: str
    status: str
    payload: dict[str, Any] = Field(default_factory=dict)
    source_refs: list[dict[str, Any]] = Field(default_factory=list)
    reason: Optional[str] = None
    created_at: str
    updated_at: str

    model_config = ConfigDict(from_attributes=True)


class DiffHunkRead(BaseModel):
    """A2 版本对比单个文档内的一个 hunk：equal（未变）或 change（相邻增删改合并块）。"""

    type: Literal["equal", "change"]
    base_start: int
    base_lines: list[str] = Field(default_factory=list)
    target_start: int
    target_lines: list[str] = Field(default_factory=list)
    pairs: list[list[int]] = Field(default_factory=list)


class DiffDocumentRead(BaseModel):
    """A2 版本对比的单篇文档条目：按 lineage（或回退 filename）配对后的增/改/删状态。

    `base_document_id`/`target_document_id`（T080 新增）是该篇文档在 base/target 各自
    版本内的真实行 id，供前端写回（编辑/归档/恢复）时定位到当前版本内的克隆行，而不是
    误用指向源文档的 `lineage_id`；对应侧不存在时为 `None`。

    `base_updated_at`/`target_updated_at`（乐观锁字段补全轮次新增）分别是
    `base_document_id`/`target_document_id` 那一行 `updated_at.isoformat()`，格式与
    `PUT /knowledge/documents/{id}` 的 `expected_updated_at` 完全一致，供前端直接原样
    回传做乐观锁；对应侧 document_id 为 `None` 时同样为 `None`。`deleted` 的
    `target_updated_at` 来自草稿内归档行（该行仍存在，只是 A2b 不返回）。
    """

    lineage_id: str
    title: str
    kind: Literal["added", "modified", "deleted"]
    truncated: bool = False
    hunks: list[DiffHunkRead] = Field(default_factory=list)
    base_document_id: str | None = None
    target_document_id: str | None = None
    base_updated_at: str | None = None
    target_updated_at: str | None = None


class VersionDiffSummary(BaseModel):
    """A2 响应的 summary：文档级新增/修改/删除计数。"""

    added: int
    modified: int
    deleted: int


class VersionDiffRead(BaseModel):
    """A2 `GET /knowledge-admin/knowledge-bases/{kb_id}/versions/{version_id}/diff` 响应。"""

    base_version_id: str | None = None
    target_version_id: str
    pairing: Literal["lineage", "filename"]
    summary: VersionDiffSummary
    documents: list[DiffDocumentRead] = Field(default_factory=list)


class VersionDocumentRead(BaseModel):
    """A2b `GET .../versions/{version_id}/documents` 响应的单篇文档条目。

    返回该版本内全部文档（含未改动的），携带真实行 `id`（区别于 A2 diff 响应里
    只出现有变化文档、且草稿克隆行会让 `lineage_id` 指向源文档的问题）。
    """

    id: str
    lineage_id: str | None = None
    title: str
    filename: str
    status: str
    bucket_count: int
    chunk_count: int
    updated_at: str


class KnowledgeRebaseRequest(BaseModel):
    """A3 `POST .../versions/{version_id}/rebase` 请求体：变基预览/执行。

    `expected_updated_at` 可选：给出时按 A5 相同语义（原样透传的 `updated_at` 字符串、
    微秒精度精确相等）做乐观锁校验，用于防住双击/重试与并发写入；不给出则不校验。
    """

    tenant_id: str
    team_id: str | None = None
    change_reason: NonEmptyText
    expected_updated_at: str | None = None
    idempotency_key: str | None = None


class KnowledgeRebaseResolutionInput(BaseModel):
    """A4 请求体中单篇冲突文档的最终合并结果。"""

    lineage_id: NonEmptyText
    content_md: str


class KnowledgeRebaseResolveRequest(BaseModel):
    """A4 `POST .../rebase/resolve` 请求体：提交冲突解决并完成变基。

    `expected_updated_at` 与 A3 同义，可选；`to_base_version_id` 仍是必填的正式版乐观锁。
    """

    tenant_id: str
    team_id: str | None = None
    change_reason: NonEmptyText
    expected_updated_at: str | None = None
    idempotency_key: str | None = None
    to_base_version_id: NonEmptyText
    resolutions: list[KnowledgeRebaseResolutionInput] = Field(default_factory=list)


class KnowledgeRebaseAutoMergedRead(BaseModel):
    """变基预览中一篇自动合并（或直接采用一方）成功的文档。"""

    lineage_id: str
    title: str
    source: Literal["ours", "theirs", "merged"]


class KnowledgeRebaseConflictBlockRead(BaseModel):
    """一个交叠冲突块的三方内容与前后各若干行上下文。"""

    base_lines: list[str] = Field(default_factory=list)
    ours_lines: list[str] = Field(default_factory=list)
    theirs_lines: list[str] = Field(default_factory=list)
    context_before: list[str] = Field(default_factory=list)
    context_after: list[str] = Field(default_factory=list)


class KnowledgeRebaseConflictRead(BaseModel):
    """一篇存在交叠冲突、需要人工解决的文档。

    `merged_text` 是三方合并后的**完整**文档：双方可自动合并的改动都已套用，每个冲突
    簇渲染成 Git 风格标记段（`<<<<<<< ours` / `=======` / `>>>>>>> theirs`），第 i 段
    对应 `blocks[i]`。前端必须基于 `merged_text` 编辑并原样提交为 A4 的 `content_md`；
    `blocks`/`context_*` 仅用于分段展示，只拼接它们会丢掉冲突区间以外的正文。
    """

    lineage_id: str
    title: str
    blocks: list[KnowledgeRebaseConflictBlockRead] = Field(default_factory=list)
    merged_text: str = ""


class KnowledgeRebasePreviewRead(BaseModel):
    """A3 有冲突时的响应：变基预览，未落库，须调用 A4 resolve 提交解决结果。"""

    status: Literal["conflicts"] = "conflicts"
    draft_version_id: str
    from_base_version_id: str | None = None
    to_base_version_id: str
    auto_merged: list[KnowledgeRebaseAutoMergedRead] = Field(default_factory=list)
    conflicts: list[KnowledgeRebaseConflictRead] = Field(default_factory=list)


class KnowledgeRebaseResultRead(BaseModel):
    """A3 无冲突或 A4 解决完成后的响应：新草稿快照与被替换的旧快照 id。"""

    status: Literal["applied"] = "applied"
    new_version: KnowledgeBaseVersionRead
    superseded_version_id: str


class KnowledgeDraftReviewRequest(BaseModel):
    """A5 `POST .../versions/{version_id}/review` 请求体：写入草稿审阅状态。"""

    tenant_id: str
    team_id: str | None = None
    staged: int = Field(ge=0)
    pending: int = Field(ge=0)
    documents_adjusted: int = Field(ge=0)
    expected_updated_at: NonEmptyText
