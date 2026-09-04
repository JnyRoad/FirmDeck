// @vitest-environment jsdom

/**
 * knowledgeAdmin.ts 的契约回归测试。
 *
 * mock `./tenant-client` 的 `createTenantClient`，直接断言
 * `createKnowledgeAdminApi(...)` 每个函数调用底层客户端时的 method（get/post/
 * put/delete/blob）、路径、query 与 body，与
 * specs/001-knowledge-base-admin/contracts/knowledge-admin-api.md 的 A1–A6、
 * B1–B5 逐一对应。`tenant_id` 由 `createTenantClient` 注入，不在此处重复断言
 * （由 tenant-client.test.ts 覆盖）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgeBaseMode } from '@/enums/knowledge';

const getMock = vi.fn();
const postMock = vi.fn();
const putMock = vi.fn();
const deleteMock = vi.fn();
const blobMock = vi.fn();
const postWithSignalMock = vi.fn();
const postBlobMock = vi.fn();

const fakeClient = {
  get: getMock,
  post: postMock,
  postWithSignal: postWithSignalMock,
  put: putMock,
  delete: deleteMock,
  blob: blobMock,
  postBlob: postBlobMock,
};

const createTenantClientMock = vi.fn(() => fakeClient);

vi.mock('./tenant-client', () => ({
  createTenantClient: createTenantClientMock,
}));

const KNOWLEDGE_ADMIN_MODULE_PATH = './knowledgeAdmin';

type KnowledgeAdminModule = typeof import('./knowledgeAdmin');

async function loadKnowledgeAdmin(): Promise<KnowledgeAdminModule> {
  try {
    const module = await import(/* @vite-ignore */ KNOWLEDGE_ADMIN_MODULE_PATH) as unknown as KnowledgeAdminModule;
    expect(typeof module.createKnowledgeAdminApi).toBe('function');
    return module;
  } catch (error) {
    throw new Error(`T029 must implement ${KNOWLEDGE_ADMIN_MODULE_PATH}: ${String(error)}`);
  }
}

/** 把 mock 收到的 path 解析成 pathname + query，便于按契约逐项断言。 */
function parsePath(rawPath: unknown) {
  const url = new URL(String(rawPath), 'http://localhost');
  return { pathname: url.pathname, search: url.searchParams };
}

beforeEach(() => {
  getMock.mockReset().mockResolvedValue({});
  postMock.mockReset().mockResolvedValue({});
  putMock.mockReset().mockResolvedValue({});
  deleteMock.mockReset().mockResolvedValue({});
  blobMock.mockReset().mockResolvedValue(new Blob());
  postWithSignalMock.mockReset();
  postBlobMock.mockReset();
  createTenantClientMock.mockClear();
});

describe('createKnowledgeAdminApi', () => {
  it('builds the client via createTenantClient(tenantContext)', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const context = { tenantId: 'tenant-a' } as never;
    createKnowledgeAdminApi(context);
    expect(createTenantClientMock).toHaveBeenCalledWith(context);
  });

  // ---- A1 ----
  it('A1 listKnowledgeBases: GET knowledge-admin/knowledge-bases with filters/pagination', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.listKnowledgeBases({
      mode: KnowledgeBaseMode.Shared,
      status: 'active',
      ownerAgentId: 'ag_1',
      teamId: 'team_1',
      q: 'FAQ',
      offset: 20,
      limit: 50,
    });

    expect(getMock).toHaveBeenCalledTimes(1);
    const { pathname, search } = parsePath(getMock.mock.calls[0][0]);
    expect(pathname).toBe('/api/enterprise/knowledge-admin/knowledge-bases');
    expect(search.get('mode')).toBe('shared');
    expect(search.get('status')).toBe('active');
    expect(search.get('owner_agent_id')).toBe('ag_1');
    expect(search.get('team_id')).toBe('team_1');
    expect(search.get('q')).toBe('FAQ');
    expect(search.get('offset')).toBe('20');
    expect(search.get('limit')).toBe('50');
  });

  it('A1 listKnowledgeBases: omits unset filters instead of sending empty values', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.listKnowledgeBases();

    const { pathname, search } = parsePath(getMock.mock.calls[0][0]);
    expect(pathname).toBe('/api/enterprise/knowledge-admin/knowledge-bases');
    expect([...search.keys()]).toEqual([]);
  });

  // ---- A6 ----
  it('A6 listBindableTeams: GET knowledge-admin/teams with exclude_bound_to', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.listBindableTeams({ excludeBoundTo: 'kb_1' });

    const { pathname, search } = parsePath(getMock.mock.calls[0][0]);
    expect(pathname).toBe('/api/enterprise/knowledge-admin/teams');
    expect(search.get('exclude_bound_to')).toBe('kb_1');
  });

  // ---- A2 ----
  it('A2 getVersionDiff: GET diff with against/max_lines query', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.getVersionDiff('kb_1', 'kbver_2', { against: 'published', maxLines: 2000 });

    const { pathname, search } = parsePath(getMock.mock.calls[0][0]);
    expect(pathname).toBe('/api/enterprise/knowledge-admin/knowledge-bases/kb_1/versions/kbver_2/diff');
    expect(search.get('against')).toBe('published');
    expect(search.get('max_lines')).toBe('2000');
  });

  // ---- A2b ----
  it('A2b listVersionDocuments: GET version documents by kbId/versionId', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.listVersionDocuments('kb_1', 'kbver_2');

    expect(getMock).toHaveBeenCalledTimes(1);
    const { pathname, search } = parsePath(getMock.mock.calls[0][0]);
    expect(pathname).toBe('/api/enterprise/knowledge-admin/knowledge-bases/kb_1/versions/kbver_2/documents');
    expect(Array.from(search.keys())).toEqual([]);
  });

  // ---- A3 ----
  it('A3 rebaseDraft: POST rebase with change_reason/idempotency_key', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.rebaseDraft('kb_1', 'kbver_2', {
      changeReason: '同步基线',
      idempotencyKey: 'idem-1',
    });

    expect(postMock).toHaveBeenCalledTimes(1);
    const [path, body] = postMock.mock.calls[0];
    expect(String(path)).toBe('/api/enterprise/knowledge-admin/knowledge-bases/kb_1/versions/kbver_2/rebase');
    expect(body).toEqual({ change_reason: '同步基线', idempotency_key: 'idem-1' });
  });

  // ---- A4 ----
  it('A4 resolveRebase: POST rebase/resolve with to_base_version_id and resolutions', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.resolveRebase('kb_1', 'kbver_2', {
      changeReason: '解决冲突',
      idempotencyKey: 'idem-2',
      toBaseVersionId: 'kbver_9',
      resolutions: [{ lineageId: 'kdoc_1', contentMd: '合并后的完整内容' }],
    });

    const [path, body] = postMock.mock.calls[0];
    expect(String(path)).toBe(
      '/api/enterprise/knowledge-admin/knowledge-bases/kb_1/versions/kbver_2/rebase/resolve',
    );
    expect(body).toEqual({
      change_reason: '解决冲突',
      idempotency_key: 'idem-2',
      to_base_version_id: 'kbver_9',
      resolutions: [{ lineage_id: 'kdoc_1', content_md: '合并后的完整内容' }],
    });
  });

  // ---- A5 ----
  it('A5 recordReview: POST review with staged/pending/documents_adjusted/expected_updated_at', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.recordReview('kb_1', 'kbver_2', {
      staged: 4,
      pending: 0,
      documentsAdjusted: 2,
      expectedUpdatedAt: '2026-09-01T00:00:00Z',
    });

    const [path, body] = postMock.mock.calls[0];
    expect(String(path)).toBe('/api/enterprise/knowledge-admin/knowledge-bases/kb_1/versions/kbver_2/review');
    expect(body).toEqual({
      staged: 4,
      pending: 0,
      documents_adjusted: 2,
      expected_updated_at: '2026-09-01T00:00:00Z',
    });
  });

  // ---- B1 ----
  it('B1 createDraft: POST drafts with nullable team_id', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.createDraft('kb_1', {
      teamId: null,
      changeReason: '管理员创建草稿',
      expectedPublishedVersionId: 'kbver_1',
    });

    const [path, body] = postMock.mock.calls[0];
    expect(String(path)).toBe('/api/enterprise/knowledge-bases/kb_1/drafts');
    expect(body).toEqual({
      team_id: null,
      change_reason: '管理员创建草稿',
      expected_published_version_id: 'kbver_1',
    });
  });

  it('B1 publishDraft: POST versions/{id}/publish with level/force_overwrite/idempotency_key', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.publishDraft('kb_1', 'kbver_2', {
      teamId: 'team_1',
      expectedPublishedVersionId: 'kbver_1',
      changeReason: '发布',
      level: 'minor' as never,
      forceOverwrite: true,
      idempotencyKey: 'idem-3',
    });

    const [path, body] = postMock.mock.calls[0];
    expect(String(path)).toBe('/api/enterprise/knowledge-bases/kb_1/versions/kbver_2/publish');
    expect(body).toEqual({
      team_id: 'team_1',
      expected_published_version_id: 'kbver_1',
      change_reason: '发布',
      level: 'minor',
      force_overwrite: true,
      idempotency_key: 'idem-3',
    });
  });

  it('B1 publishDraft: omits level/force_overwrite when unset so backend applies contract defaults', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.publishDraft('kb_1', 'kbver_2', {
      teamId: null,
      expectedPublishedVersionId: 'kbver_1',
      changeReason: '发布',
    });

    const [, body] = postMock.mock.calls[0];
    // `toEqual` treats keys with an `undefined` value as absent, matching what
    // `JSON.stringify` actually sends over the wire.
    expect(body).toEqual({
      team_id: null,
      expected_published_version_id: 'kbver_1',
      change_reason: '发布',
      level: undefined,
      force_overwrite: undefined,
      idempotency_key: undefined,
    });
  });

  it('B1 rejectDraft: POST versions/{id}/reject', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.rejectDraft('kb_1', 'kbver_2', {
      teamId: 'team_1',
      changeReason: '不合规范',
      idempotencyKey: 'idem-4',
    });

    const [path, body] = postMock.mock.calls[0];
    expect(String(path)).toBe('/api/enterprise/knowledge-bases/kb_1/versions/kbver_2/reject');
    expect(body).toEqual({
      team_id: 'team_1',
      change_reason: '不合规范',
      idempotency_key: 'idem-4',
    });
  });

  it('B1 rollbackVersion: POST rollback with target_version_id/expected_published_version_id', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.rollbackVersion('kb_1', {
      teamId: null,
      targetVersionId: 'kbver_3',
      expectedPublishedVersionId: 'kbver_5',
      changeReason: '回滚',
      idempotencyKey: 'idem-5',
    });

    const [path, body] = postMock.mock.calls[0];
    expect(String(path)).toBe('/api/enterprise/knowledge-bases/kb_1/rollback');
    expect(body).toEqual({
      team_id: null,
      target_version_id: 'kbver_3',
      expected_published_version_id: 'kbver_5',
      change_reason: '回滚',
      idempotency_key: 'idem-5',
    });
  });

  // ---- B2 ----
  it('B2 listVersions: GET versions with optional agent_id', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.listVersions('kb_1', 'ag_1');

    const { pathname, search } = parsePath(getMock.mock.calls[0][0]);
    expect(pathname).toBe('/api/enterprise/knowledge-bases/kb_1/versions');
    expect(search.get('agent_id')).toBe('ag_1');
  });

  it('B2 listVersions: omits agent_id when not provided', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.listVersions('kb_1');

    const { pathname, search } = parsePath(getMock.mock.calls[0][0]);
    expect(pathname).toBe('/api/enterprise/knowledge-bases/kb_1/versions');
    expect(search.has('agent_id')).toBe(false);
  });

  // ---- B3 ----
  it('B3 uploadDocument: POST knowledge/documents?agent_id with draft version id', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.uploadDocument({
      knowledgeBaseId: 'kb_1',
      knowledgeBaseVersionId: 'kbver_2',
      filename: 'a.md',
      contentBase64: 'YmFzZTY0',
      title: '标题',
      capabilityScope: 'general',
      metadata: { lineage_id: 'kdoc_1' },
    }, 'ag_1');

    const { pathname, search } = parsePath(postMock.mock.calls[0][0]);
    expect(pathname).toBe('/api/enterprise/knowledge/documents');
    expect(search.get('agent_id')).toBe('ag_1');
    expect(postMock.mock.calls[0][1]).toEqual({
      knowledge_base_id: 'kb_1',
      knowledge_base_version_id: 'kbver_2',
      filename: 'a.md',
      content_base64: 'YmFzZTY0',
      title: '标题',
      capability_scope: 'general',
      metadata: { lineage_id: 'kdoc_1' },
    });
  });

  it('B3 updateDocument: PUT knowledge/documents/{id} with content_md/expected_updated_at', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.updateDocument('kdoc_1', {
      title: '新标题',
      status: 'ready',
      contentMd: '# 内容',
      expectedUpdatedAt: '2026-09-01T00:00:00Z',
    }, 'ag_1');

    const { pathname, search } = parsePath(putMock.mock.calls[0][0]);
    expect(pathname).toBe('/api/enterprise/knowledge/documents/kdoc_1');
    expect(search.get('agent_id')).toBe('ag_1');
    expect(putMock.mock.calls[0][1]).toEqual({
      title: '新标题',
      status: 'ready',
      metadata: undefined,
      content_md: '# 内容',
      expected_updated_at: '2026-09-01T00:00:00Z',
    });
  });

  it('B3 archiveDocument: PUT knowledge/documents/{id} with status=archived', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.archiveDocument('kdoc_1', { expectedUpdatedAt: '2026-09-01T00:00:00Z' });

    const { pathname, search } = parsePath(putMock.mock.calls[0][0]);
    expect(pathname).toBe('/api/enterprise/knowledge/documents/kdoc_1');
    expect(search.has('agent_id')).toBe(false);
    expect(putMock.mock.calls[0][1]).toEqual({
      status: 'archived',
      expected_updated_at: '2026-09-01T00:00:00Z',
    });
  });

  // ---- existing reused endpoints ----
  it('getKnowledgeBase: GET knowledge-bases/{id}', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.getKnowledgeBase('kb_1', 'ag_1');

    const { pathname, search } = parsePath(getMock.mock.calls[0][0]);
    expect(pathname).toBe('/api/enterprise/knowledge-bases/kb_1');
    expect(search.get('agent_id')).toBe('ag_1');
  });

  it('updateKnowledgeBase: PUT knowledge-bases/{id} with name/description/status/capability_scope', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.updateKnowledgeBase('kb_1', {
      name: '新名字',
      description: '描述',
      status: 'archived',
      capabilityScope: 'sop_specific',
    });

    const [path, body] = putMock.mock.calls[0];
    expect(String(parsePath(path).pathname)).toBe('/api/enterprise/knowledge-bases/kb_1');
    expect(body).toEqual({
      name: '新名字',
      description: '描述',
      status: 'archived',
      capability_scope: 'sop_specific',
      metadata: undefined,
    });
  });

  it('deleteKnowledgeBase: DELETE knowledge-bases/{id} without agent_id for admin callers', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.deleteKnowledgeBase('kb_1');

    expect(deleteMock).toHaveBeenCalledTimes(1);
    const { pathname, search } = parsePath(deleteMock.mock.calls[0][0]);
    expect(pathname).toBe('/api/enterprise/knowledge-bases/kb_1');
    expect(search.has('agent_id')).toBe(false);
  });

  it('listTeamBindings: GET teams/{id}/knowledge-bases', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.listTeamBindings('team_1');

    expect(getMock).toHaveBeenCalledWith('/api/enterprise/teams/team_1/knowledge-bases');
  });

  it('bindTeam: POST teams/{id}/knowledge-bases with existing_knowledge_base_id', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.bindTeam('team_1', { existingKnowledgeBaseId: 'kb_9', isDefault: false });

    expect(postMock).toHaveBeenCalledWith('/api/enterprise/teams/team_1/knowledge-bases', {
      existing_knowledge_base_id: 'kb_9',
      create_shared: undefined,
      is_default: false,
    });
  });

  it('bindTeam: POST teams/{id}/knowledge-bases with create_shared', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.bindTeam('team_1', { createShared: { name: '新共享库' } });

    expect(postMock).toHaveBeenCalledWith('/api/enterprise/teams/team_1/knowledge-bases', {
      existing_knowledge_base_id: undefined,
      create_shared: { name: '新共享库' },
      is_default: undefined,
    });
  });

  it('unbindTeam: DELETE teams/{id}/knowledge-bases/{kb_id} with expected_revision', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.unbindTeam('team_1', 'kb_1', { expectedRevision: 3 });

    expect(deleteMock).toHaveBeenCalledWith('/api/enterprise/teams/team_1/knowledge-bases/kb_1', {
      expected_revision: 3,
    });
  });

  it('setDefaultBinding: PUT teams/{id}/knowledge-bases/{kb_id} with is_default=true', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.setDefaultBinding('team_1', 'kb_1', { expectedRevision: 4 });

    expect(putMock).toHaveBeenCalledWith('/api/enterprise/teams/team_1/knowledge-bases/kb_1', {
      expected_revision: 4,
      is_default: true,
    });
  });

  it('B5 saveGrants: PUT teams/{id}/knowledge-bases/{kb_id}/grants with full matrix', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.saveGrants('team_1', 'kb_1', {
      expectedRevision: 5,
      grants: [{ agent_id: 'ag_1', permission: 'editor' as never }],
    });

    expect(putMock).toHaveBeenCalledWith(
      '/api/enterprise/teams/team_1/knowledge-bases/kb_1/grants',
      {
        expected_revision: 5,
        grants: [{ agent_id: 'ag_1', permission: 'editor' }],
      },
    );
  });

  it('listAuditEvents: GET knowledge-bases/{id}/audit-events with all filters', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.listAuditEvents('kb_1', {
      offset: 10,
      limit: 25,
      teamId: 'team_1',
      action: 'draft_reviewed',
      actorType: 'user',
      actorId: 'user_1',
      versionId: 'kbver_2',
    });

    const { pathname, search } = parsePath(getMock.mock.calls[0][0]);
    expect(pathname).toBe('/api/enterprise/knowledge-bases/kb_1/audit-events');
    expect(search.get('offset')).toBe('10');
    expect(search.get('limit')).toBe('25');
    expect(search.get('team_id')).toBe('team_1');
    expect(search.get('action')).toBe('draft_reviewed');
    expect(search.get('actor_type')).toBe('user');
    expect(search.get('actor_id')).toBe('user_1');
    expect(search.get('version_id')).toBe('kbver_2');
  });

  it('exportOkf: blob GET knowledge-bases/{id}/okf/export', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.exportOkf('kb_1', 'ag_1');

    expect(blobMock).toHaveBeenCalledTimes(1);
    const { pathname, search } = parsePath(blobMock.mock.calls[0][0]);
    expect(pathname).toBe('/api/enterprise/knowledge-bases/kb_1/okf/export');
    expect(search.get('agent_id')).toBe('ag_1');
  });

  it('lintOkf: POST knowledge-bases/{id}/okf/lint', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.lintOkf('kb_1', 'ag_1');

    const { pathname, search } = parsePath(postMock.mock.calls[0][0]);
    expect(pathname).toBe('/api/enterprise/knowledge-bases/kb_1/okf/lint');
    expect(search.get('agent_id')).toBe('ag_1');
  });

  it('convertToShared: POST knowledge-bases/{id}/convert-to-shared with team_bindings', async () => {
    const { createKnowledgeAdminApi } = await loadKnowledgeAdmin();
    const api = createKnowledgeAdminApi(null, fakeClient as never);

    await api.convertToShared('kb_1', {
      agentId: 'ag_1',
      sourceVersionId: 'kbver_2',
      name: '新共享库',
      description: '描述',
      changeReason: '转换为共享',
      teamBindings: ['team_1', 'team_2'],
      defaultForTeamId: 'team_1',
    });

    const [path, body] = postMock.mock.calls[0];
    expect(String(path)).toBe('/api/enterprise/knowledge-bases/kb_1/convert-to-shared');
    expect(body).toEqual({
      agent_id: 'ag_1',
      source_version_id: 'kbver_2',
      name: '新共享库',
      description: '描述',
      change_reason: '转换为共享',
      team_bindings: ['team_1', 'team_2'],
      default_for_team_id: 'team_1',
    });
  });
});
