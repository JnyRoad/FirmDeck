# 前端开发

- React/TypeScript 代码位于 `frontend-enterprise/src/`，静态资源位于
  `frontend-enterprise/public/`，测试与实现文件同目录放置，命名为 `*.test.ts(x)`。
- 使用 `npm --prefix frontend-enterprise ci` 安装锁定版本的前端依赖。
- 保持 TypeScript 严格模式；使用两空格缩进、单引号、分号、`PascalCase` 组件名、
  `use...` Hook 名，以及适用时的 `@/` 导入别名。
- 为已修改的行为补充聚焦的回归测试。运行相关 Vitest 测试；当改动范围和依赖条件允许时，
  再运行 `npm --prefix frontend-enterprise test` 和
  `npm --prefix frontend-enterprise run build`。
- 修改 Vite 环境变量用法时，运行
  `npm --prefix frontend-enterprise run config:check`。
- 修改可见 UI 时，在浏览器中验证受影响的路由和用户角色。

## 前端组件规范（frontend-enterprise）

新页面或重构时，**优先使用 shadcn/ui 组件**，而非新增 Ant Design 组件。

- shadcn/ui 组件位于 `@/components/ui`，通过 `@/components/ui` 桶文件统一导入。
- 类名合并使用 `cn()`（来自 `@/lib/utils`）。
- 通知使用 `sonner` 的 `toast`，而非 `antd` 的 `message`。
- 现有页面中的 Ant Design 组件保持不变，除非本次任务明确要求重构；不要为了替换而替换。

```tsx
// ✅ 推荐 — 新页面使用 shadcn/ui
import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '@/components/ui';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

// ❌ 避免 — 新页面不再新增 Ant Design 组件
import { Button, Card, Input, message } from 'antd';
```

新增尚未安装的 shadcn 组件：

```bash
cd frontend-enterprise && npx shadcn@latest add <component> -y
```

## 图标规范

页面中使用的各种 icon，**先在 `src/assets/` 下生成 SVG 图标文件，再引入页面中使用**，不要在 JSX 里内联手写 SVG 路径。

```tsx
// ✅ 推荐 — 先落到 assets，再作为组件/资源引入
import ArrowIcon from '@/assets/icons/arrow.svg?react';
// 或统一封装后按名引用
import { StaffdeckIcon } from '@/components/StaffdeckIcon';

<ArrowIcon className="size-4" />;

// ❌ 避免 — 在页面里内联手写 SVG
<svg viewBox="0 0 24 24"><path d="M..." /></svg>;
```

## 枚举规范

考虑后续维护，**状态、类型等有限取值的字段应先在 `enums` 中定义枚举/常量，再引用**，避免在业务代码里散落魔法字符串。

```ts
// ✅ 推荐 — 先在 enums 中集中定义
// src/enums/agentStatus.ts
export enum AgentStatus {
  Active = 'active',
  Onboarding = 'onboarding',
  Archived = 'archived',
}

if (agent.status === AgentStatus.Active) { /* ... */ }

// ❌ 避免 — 业务代码里散落魔法字符串
if (agent.status === 'active') { /* ... */ }
```
