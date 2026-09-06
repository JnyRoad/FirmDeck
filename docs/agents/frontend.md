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

## 国际化与 raw 内容边界

所有前端产品消息遵循根 `CONTEXT.md` 和
`docs/adr/ADR-001-i18n-runtime-and-catalog.md`。当前正式语言为 `zh-CN`、`en-US`：
`en-US` 是 canonical catalog，`zh-CN` 是兼容默认；语言值使用 BCP 47，不能在业务代码中
散落 locale 或时区常量。

- 新增 JSX、页面标题、路由标题、表单、校验、帮助、Toast、弹窗、状态、空/加载/错误、表格、
  图表、筛选、分页、`aria-*`、`title`、`alt`、剪贴板提示、下载前缀、iframe/postMessage
  外壳文案时，必须使用稳定英文语义 `MessageId`/`MessageDescriptor`。文案本身不是键；禁止
  中文/英文自然语言作键、动态键和字符串拼接。
- React 组件内使用 `useAppIntl()`（且只能在 `AppIntlProvider` 子树中）或传入 descriptor；
  组件外使用显式注入的 `createAppTranslator(locale)`。不得在组件外调用 Hook，不得在新代码
  使用 legacy `useI18n` source-key facade。
- `Input`/`Textarea` 的 placeholder、title、`aria-label` 等只有 `MessageDescriptor` 才进入
  翻译；普通字符串保持原样。`createToastNotifier`、`createUiSinks` 等 non-DOM sink 只接受
  descriptor。legacy `notify` 只能在登记的兼容边界使用。
- 用户输入、员工/团队/知识库/文档名称和正文、引用、Agent/工具/provider 原文、密钥、路径、
  文件名 raw 部分和技术日志不得翻译。用 `RawContent`/`RawIdentifier` 标记精确值，不能给父
  容器加宽泛 `data-i18n-ignore` 或依赖 observer 覆盖相邻产品消息。
- 日期/时间/数字/百分比/货币/相对时间/列表/排序使用 `Intl`/共享 formatter，并显式处理时区
  和单位；复数/选择/插值使用 ICU 具名变量，不能使用数字占位符、`${}` 文案拼接或固定 locale。
- 后端错误/事件只消费稳定 code/event_code、message key 和具名 params；raw `detail`、异常、
  provider body 只用于诊断，不得直接展示。Agent reply locale 与 UI locale 分离，前端不得因
  UI 切换而改写历史消息或业务内容。

## 前端变更验收

每次新增产品消息或 locale-sensitive behavior 先写回归测试，再运行：

```bash
npm --prefix frontend-enterprise run i18n:check
npm --prefix frontend-enterprise test
npm --prefix frontend-enterprise run build
```

可用时补充 `npm --prefix frontend-enterprise run test:e2e:i18n`，至少切换 `zh-CN`、`en-US`，
并覆盖关键路由、角色、权限、正常/空/加载/错误、无障碍属性、响应式视口、原生对话框、Toast、
iframe/postMessage、剪贴板、下载和伪本地化。无法真实运行的浏览器、第三方嵌入或 provider 路径
必须标记 `UNVERIFIED`。提交前检查 catalog 键/ICU/参数一致性、精确 legacy allowlist 的 owner、
fingerprint、reason、ISO `expires`，以及 `git diff --check`。

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
import { FirmdeckIcon } from '@/components/FirmdeckIcon';

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
