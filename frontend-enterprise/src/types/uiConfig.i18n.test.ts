import { describe, expect, it } from 'vitest';

import type {
  SandboxRemediationParams,
  SandboxSetupParams,
  SandboxStatusParams,
  UIConfigRead,
} from './index';

const stableSandboxFields = {
  sandbox_status: 'unavailable',
  sandbox_status_code: 'SANDBOX_WINDOWS_SETUP_REQUIRED',
  sandbox_status_params: { backend: 'srt' },
  sandbox_remediation_code: 'SANDBOX_WINDOWS_SETUP_REQUIRED',
  sandbox_remediation_params: { command: '/opt/firmdeck/node srt-cli.js windows-install' },
  sandbox_setup_code: 'SANDBOX_WINDOWS_SETUP_REQUIRED',
  sandbox_setup_params: { command: '/opt/firmdeck/node srt-cli.js windows-install' },
} satisfies Pick<
  UIConfigRead,
  | 'sandbox_status'
  | 'sandbox_status_code'
  | 'sandbox_status_params'
  | 'sandbox_remediation_code'
  | 'sandbox_remediation_params'
  | 'sandbox_setup_code'
  | 'sandbox_setup_params'
>;

const statusParams: SandboxStatusParams = { backend: 'srt' };
const remediationParams: SandboxRemediationParams = { command: null };
const setupParams: SandboxSetupParams = { command: 'node srt-cli.js windows-install' };

// @ts-expect-error Legacy localized prose must not be part of the UI config contract.
type LegacySandboxStatusMessage = UIConfigRead['sandbox_status_message'];

// @ts-expect-error Raw diagnostic prose is not a typed status parameter.
const invalidStatusParams = { backend: 'srt', message: 'raw diagnostic' } satisfies SandboxStatusParams;

// @ts-expect-error Setup parameters must retain a raw command string.
const invalidSetupParams = { command: 42 } satisfies SandboxSetupParams;

describe('UIConfig sandbox response contract', () => {
  it('models stable codes and typed raw parameters for status, remediation, and setup', () => {
    expect(stableSandboxFields.sandbox_status_params?.backend).toBe('srt');
    expect(stableSandboxFields.sandbox_setup_params?.command).toContain('windows-install');
    expect(statusParams.backend).toBe('srt');
    expect(remediationParams.command).toBeNull();
    expect(setupParams.command).toBe('node srt-cli.js windows-install');
  });

  it('keeps compile-time negative assertions active for removed prose and malformed params', () => {
    expect(invalidStatusParams.message).toBe('raw diagnostic');
    expect(invalidSetupParams.command).toBe(42);
  });
});
