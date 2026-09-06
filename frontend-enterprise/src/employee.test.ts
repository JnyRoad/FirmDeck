import { describe, expect, it } from 'vitest';

import {
  EMPLOYEE_AVATAR_PRESETS,
  EMPLOYEE_TEMPLATES,
  employeeAvatarImage,
  employeeMetadataFromTemplate,
} from './employee';

const EXPANDED_EMPLOYEES = [
  ['sales-advisor', 'sales-handshake', '销售', '客户拓展顾问', 'firmdeck-avatar-sales.png'],
  ['marketing-planner', 'marketing-spark', '市场', '市场内容策划', 'firmdeck-avatar-marketing.png'],
  ['procurement-coordinator', 'procurement-check', '采购', '采购协同专员', 'firmdeck-avatar-procurement.png'],
  ['project-manager', 'project-board', '项目管理', '项目推进经理', 'firmdeck-avatar-project.png'],
  ['data-analyst', 'data-insight', '数据分析', '经营分析师', 'firmdeck-avatar-data.png'],
  ['hr-partner', 'ops-grid', '人事', '员工服务助手', 'firmdeck-avatar-ops.png'],
  ['legal-reviewer', 'quality-star', '法务', '合规审查官', 'firmdeck-avatar-quality.png'],
  ['customer-support', 'customer-service', '客服', '客户成功专员', 'firmdeck-avatar-customer-service.png'],
  ['operations-lead', 'operations-flow', '运营', '日常运营专员', 'firmdeck-avatar-operations.png'],
  ['it-helpdesk', 'it-support', 'IT支持', '内部支持工程师', 'firmdeck-avatar-it-support.png'],
  ['brand-designer', 'brand-design', '品牌设计', '品牌视觉设计师', 'firmdeck-avatar-brand-design.png'],
  ['training-specialist', 'training-coach', '培训', '培训与发展专员', 'firmdeck-avatar-training.png'],
  ['strategy-planner', 'strategy-compass', '战略规划', '战略规划顾问', 'firmdeck-avatar-strategy.png'],
] as const;

describe('expanded employee presets', () => {
  it.each(EXPANDED_EMPLOYEES)(
    'registers %s with its own avatar and template metadata',
    (roleKey, avatarPreset, categoryName, roleName, avatarFilename) => {
      const preset = EMPLOYEE_AVATAR_PRESETS.find((item) => item.key === avatarPreset);
      const template = EMPLOYEE_TEMPLATES.find((item) => item.key === roleKey);
      const metadata = employeeMetadataFromTemplate(roleKey);
      const avatarImage = employeeAvatarImage({
        avatarKind: 'preset',
        avatarImage: '',
        avatarPreset,
      });

      expect(preset?.label).toContain(categoryName);
      expect(template).toMatchObject({ roleName, avatarPreset });
      expect(metadata).toMatchObject({
        role_key: roleKey,
        role_name: roleName,
        avatar_kind: 'preset',
        avatar_preset: avatarPreset,
      });
      expect(avatarImage).toContain(avatarFilename);
    },
  );

  it('uses a distinct illustration for each expanded employee', () => {
    const images = EXPANDED_EMPLOYEES.map(([, avatarPreset]) => employeeAvatarImage({
      avatarKind: 'preset',
      avatarImage: '',
      avatarPreset,
    }));

    expect(new Set(images)).toHaveLength(EXPANDED_EMPLOYEES.length);
  });
});
