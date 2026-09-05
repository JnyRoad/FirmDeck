/**
 * useGuardedLoad — 知识库管理端各 Tab 复用的「过期响应护栏」（跨任务评审 I1）。
 *
 * 背景：`KnowledgeAdminListPage.tsx` 同时有两道保护，六个详情 Tab 一道都没有——
 * 1. **请求序号**（`listRequestSeqRef`/`summaryRequestSeqRef`）：同一会话内筛选/视图
 *    快速切换时，先发的请求可能后返回，把已经过期的数据盖回最新状态上。内容 Tab 的
 *    `?view=` 切换是最危险的一处：`diff`/`versionDocuments` 落后一个版本，而删除/恢复
 *    按钮会拿着**上一个版本的真实文档 id** 去写回。
 * 2. **租户代际**（`TenantSessionContext.isCurrentGeneration`）：跨租户/跨登录会话切换
 *    后，旧租户的在途响应不得再落到新租户的界面上。
 *
 * 用法（每个独立的加载动作各调用一次本 Hook，各自拥有一条序号线）：
 *
 * ```ts
 * const diffLoad = useGuardedLoad();
 * async function loadDiff() {
 *   const token = diffLoad.begin();
 *   setLoading(true);
 *   try {
 *     const result = await api.getVersionDiff(...);
 *     if (!diffLoad.isCurrent(token)) return;
 *     setDiff(result);
 *   } catch (error) {
 *     if (!diffLoad.isCurrent(token)) return;
 *     toast.error(error, 'knowledgeAdmin.toast.loadFailed');
 *   } finally {
 *     if (diffLoad.isCurrent(token)) setLoading(false);
 *   }
 * }
 * ```
 *
 * 没有 `TenantSessionProvider`（组件级单测）时只保留序号护栏，代际检查视为通过——
 * 详情页在真实应用里始终挂在 Provider 之内，单测不需要为了这道护栏搭一套会话。
 */
import { useMemo, useRef } from 'react';

import { useTenantSession } from '@/contexts/TenantSessionContext';

/** 一次加载动作的护栏令牌：本次的请求序号 + 发起时捕获的租户代际。 */
export type GuardedLoadToken = {
  seq: number;
  generation: number | undefined;
};

export type GuardedLoad = {
  /** 在发起请求前调用，占用一个新的序号并捕获当前租户代际。 */
  begin: () => GuardedLoadToken;
  /** 在 await 之后、写 state 之前调用；返回 false 表示这次响应已过期，必须整个丢弃。 */
  isCurrent: (token: GuardedLoadToken) => boolean;
};

/**
 * 创建一条独立的加载护栏（一个请求序号 + 租户代际检查）。
 * 输入：无；输出：`{begin, isCurrent}`，引用在组件生命周期内稳定，可安全放进依赖数组。
 */
export function useGuardedLoad(): GuardedLoad {
  const tenantContext = useTenantSession();
  // 用 ref 读取最新的 context，避免把 `begin`/`isCurrent` 的引用绑到 context 上——
  // 它们被调用时总是要看"此刻"的代际，而不是某次渲染快照里的。
  const contextRef = useRef(tenantContext);
  contextRef.current = tenantContext;
  const seqRef = useRef(0);

  return useMemo<GuardedLoad>(() => ({
    begin() {
      const seq = seqRef.current + 1;
      seqRef.current = seq;
      return { seq, generation: contextRef.current?.generation };
    },
    isCurrent(token) {
      if (seqRef.current !== token.seq) return false;
      const context = contextRef.current;
      if (!context || token.generation === undefined) return true;
      return context.isCurrentGeneration(token.generation);
    },
  }), []);
}
