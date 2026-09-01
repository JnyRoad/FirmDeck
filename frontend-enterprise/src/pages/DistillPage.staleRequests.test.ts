// @vitest-environment jsdom

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { TenantSessionContextValue } from '../contexts/TenantSessionContext';

import { isCurrentTenantRequest } from './DistillPage';

function makeContext(generation = 1) {
  const controller = new AbortController();
  const context = {
    generation,
    signal: controller.signal,
    isCurrentGeneration: (candidate: number) => candidate === generation && !controller.signal.aborted,
  } as Pick<TenantSessionContextValue, 'generation' | 'signal' | 'isCurrentGeneration'>;
  return { context, controller };
}

describe('DistillPage stale tenant request fences', () => {
  it('does not run a side effect for an old generation or an aborted request', () => {
    const current = makeContext(4);
    const sideEffect = vi.fn();
    const requestController = new AbortController();

    if (isCurrentTenantRequest(current.context, 4, requestController.signal)) sideEffect();
    expect(sideEffect).toHaveBeenCalledOnce();

    sideEffect.mockClear();
    expect(isCurrentTenantRequest(current.context, 3, requestController.signal)).toBe(false);
    if (isCurrentTenantRequest(current.context, 3, requestController.signal)) sideEffect();
    expect(sideEffect).not.toHaveBeenCalled();

    sideEffect.mockClear();
    requestController.abort();
    expect(isCurrentTenantRequest(current.context, 4, requestController.signal)).toBe(false);
    if (isCurrentTenantRequest(current.context, 4, requestController.signal)) sideEffect();
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('requires save and probe request rejection handlers to fence every side effect', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'DistillPage.tsx'), 'utf8');
    const saveStart = source.indexOf('  async function saveDraft()');
    const saveEnd = source.indexOf('  function stopStream()', saveStart);
    const saveBlock = source.slice(saveStart, saveEnd);
    const probeStart = source.indexOf('  async function probeToolSuggestion(');
    const probeEnd = source.indexOf('  function applyProbeArgumentsFromDetail()', probeStart);
    const probeBlock = source.slice(probeStart, probeEnd);

    expect(saveBlock).toContain('const generation = context?.generation;');
    expect(saveBlock).toContain('const controller = new AbortController();');
    expect(saveBlock).toContain('signal: controller.signal');
    expect(saveBlock).toMatch(/catch \(error\) \{[\s\S]*isCurrentTenantRequest\(context, generation, controller\.signal\)[\s\S]*notify\.error/);
    expect(saveBlock).toMatch(/finally \{[\s\S]*isCurrentTenantRequest\(context, generation, controller\.signal\)/);

    expect(probeBlock).toContain('const generation = context?.generation;');
    expect(probeBlock).toContain('const controller = new AbortController();');
    expect(probeBlock).toContain('signal: controller.signal');
    expect(probeBlock).toMatch(/if \(!isCurrentTenantRequest\(context, generation, controller\.signal\)\) return null;/);
    expect(probeBlock).toMatch(/catch \(error\) \{[\s\S]*isCurrentTenantRequest\(context, generation, controller\.signal\)[\s\S]*setToolSuggestionPatch/);
    expect(probeBlock).toMatch(/finally \{[\s\S]*isCurrentTenantRequest\(context, generation, controller\.signal\)/);
  });
});
