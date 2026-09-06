# 国际化浏览器验收记录

状态：`COMPLETE_WITH_UNVERIFIED_BOUNDARIES`

基线：`a22231d00770ba6958f2a2bf1b0d65008bd858c3`，分支 `feat/i18n-governance`。验收使用独立
SQLite `sqlite:////private/tmp/firmdeck-i18n-browser-862a.db` 和 `127.0.0.1:5187`，未连接生产数据。

## 真实本地应用矩阵

2026-08-30 在 macOS arm64 的本地 Chrome 中验证真实前后端，结果文件为
`/private/tmp/firmdeck-i18n-browser-results-862a.json`。

| 维度 | 范围 | 结果 |
|---|---|---|
| locale | `zh-CN` 51 项、`en-US` 51 项 | 102/102 PASS |
| viewport | 1440 desktop、1024 tablet、390 mobile，各 30 个路由项 | 90/90 PASS |
| 路由 | platform、agents、teams、channels、dashboard、scheduled tasks、knowledge、general skills、SOP、tools、accounts、models、runtime settings、gallery | 84/84 PASS |
| 权限 | administrator 正常页；member 对 accounts/models/runtime-settings 的 denied 状态；signed-out | 10/10 PASS |
| 交互 | locale 持久化、弹窗/表单/ARIA、member diagnostics | 8/8 PASS |
| 布局/无障碍 | 水平溢出为 0，无 unnamed button，无 missing-message diagnostic | PASS |

代表性成功截图保存在 `docs/i18n/screenshots/`：两个正式 locale、desktop/mobile、
platform/gallery/knowledge/tools/dashboard，共 20 张。切换到 `en-US` 后，测试中的中文员工名与
业务原文保持原样，证明 UI locale 没有改写业务数据。

## 专项 Playwright 矩阵

clean `npm ci` 后重跑：

```text
npm --prefix frontend-enterprise run test:e2e:i18n
8 passed (4.9s)
```

| 视口 | locale | 覆盖 | 结果 |
|---|---|---|---|
| Desktop Chrome | `zh-CN` / `en-US` | 登录、标题、表单、ARIA、`html[lang]`、溢出 | PASS |
| Pixel 7 Chrome | `zh-CN` / `en-US` | 同上，移动视口 | PASS |
| Desktop Chrome | `en-XA` | 长文本、raw 原文、iframe title、postMessage 产品错误、native prompt | PASS |
| Pixel 7 Chrome | `en-XA` | 同上，移动视口 | PASS |

clipboard、下载/导出、Toast、日期/数字/复数与未知错误 fallback 还有对应的 Vitest/组件测试；
本记录不把单元测试冒充为人工浏览器点击证据。

## 分类边界

- `PASS`：上述本地 Chrome、正式 locale、伪本地化、路由/权限/响应式/特殊 sink。
- `THIRD_PARTY_CONSTRAINED`：飞书/钉钉/企微/微信、远程 A2A/MCP/provider 内部 UI 与自然语言协商。
- `UNVERIFIED`：真实第三方 Agent 是否遵循 reply locale；Firefox、WebKit；macOS/Windows/Linux
  打包产物；生产数据与真实外部账号。
- Skill stream job store 仍为进程内存实现，真实跨进程恢复保持 `UNVERIFIED`。

最终代码树首次在受限沙箱启动 Chrome 时因 `SIGABRT/EPERM` 失败，8 个用例均未进入断言；
获准后在沙箱外以同一代码与命令重跑为 8/8 PASS。这是环境限制，不计作产品失败或产品 PASS。
