const asset = (name: string) => `./staffdeck_introduce_assets/${name}`;

export const tutorialShared = {
  zh: {
    home: "首页",
    docs: "文档",
    showcase: "案例",
    research: "研究",
    team: "团队",
    breadcrumbHome: "首页",
    tocTitle: "本页目录",
    prev: "上一页",
    next: "下一页",
    footer: "Copyright © 2026 StaffDeck",
  },
  en: {
    home: "Home",
    docs: "Docs",
    showcase: "Showcase",
    research: "Research",
    team: "Team",
    breadcrumbHome: "Home",
    tocTitle: "On this page",
    prev: "Previous",
    next: "Next",
    footer: "Copyright © 2026 StaffDeck",
  },
} as const;

export const tutorialNavGroups = [
  {
    title: { zh: "开始使用", en: "Getting Started" },
    items: [
      { id: "introduce", label: { zh: "项目简介", en: "Project Introduction" } },
      { id: "core", label: { zh: "核心能力", en: "Core Capabilities" } },
      { id: "why", label: { zh: "为什么选择 StaffDeck", en: "Why StaffDeck" } },
      { id: "quick", label: { zh: "快速开始", en: "Quick Start" } },
    ],
  },
  {
    title: { zh: "核心功能", en: "Core Features" },
    items: [
      { id: "employee", label: { zh: "数字员工管理", en: "Digital Employee Management" } },
      { id: "sop", label: { zh: "流程型技能", en: "Process Skills" } },
      { id: "knowledge", label: { zh: "企业知识本体", en: "Enterprise Knowledge Ontology" } },
      { id: "ops", label: { zh: "自动任务与 Trace", en: "Scheduled Tasks and Trace" } },
    ],
  },
  {
    title: { zh: "案例展示", en: "Use Cases" },
    items: [
      { id: "handover", label: { zh: "经验继承", en: "Knowledge Handover" } },
      { id: "qa", label: { zh: "重复问答分担", en: "High-volume Q&A" } },
      { id: "proactive", label: { zh: "主动工作", en: "Proactive Work" } },
    ],
  },
] as const;

export const tutorialPages = [
  {
    id: "introduce",
    title: { zh: "项目简介", en: "Project Introduction" },
    toc: {
      zh: [
        { id: "intro", label: "StaffDeck" },
        { id: "positioning", label: "产品定位" },
        { id: "reliability", label: "三层可靠性" },
        { id: "docs-map", label: "文档地图" },
      ],
      en: [
        { id: "intro", label: "StaffDeck" },
        { id: "positioning", label: "Positioning" },
        { id: "reliability", label: "Reliability Model" },
        { id: "docs-map", label: "Documentation Map" },
      ],
    },
    content: {
      zh: `
        <section id="intro">
          <h1>StaffDeck</h1>
          <p class="lead">StaffDeck 是数字员工全流程构建与管理平台，把重复工作交给数字员工，把时间留给真正重要的事。</p>
          <p>过去几年，企业采购了大量 AI 工具，但真正沉淀下来的能力并不多：提示词留在个人电脑里，业务流程散落在文档角落，Agent 上线后缺少反馈迭代，专业员工仍然被重复咨询占用。</p>
          <p>StaffDeck 的出发点不是再做一个聊天机器人，而是让 AI 以“数字员工”的方式进入组织：有岗位、有工号、有能力边界、有工作记录，也有可以持续修订的 SOP、知识库、工具和 Trace。</p>
          <p class="strong-line">从流程数字化迈向组织智能化，让 AI 成为可管理、可信赖、可沉淀的一员。</p>
          <div class="screenshot">
            <img src="${asset("introduce-hero.png")}" alt="StaffDeck 数字员工运营平台首页">
            <div class="caption">StaffDeck Preview 首页：围绕数字员工广场、员工能力与业务入口组织产品体验。</div>
          </div>
        </section>
        <section id="positioning">
          <h2>产品定位</h2>
          <p>StaffDeck 面向希望把 AI 从个人效率工具升级为组织生产力的企业与机构。专业员工可以把自己的经验、知识和处理流程固化成一位可以持续工作的数字员工，接手重复性沟通与标准化任务。</p>
          <p>平台覆盖数字员工创建、流程型技能、企业知识本体、工具接入、定时任务、对话追踪和反馈分析等核心链路。Preview 版本已开源，适合本地体验、二次开发和围绕真实业务场景做验证。</p>
          <div class="card-group cols-3">
            <div class="doc-card"><div class="card-head"><span class="card-icon">员</span><span>数字员工</span></div><p>把个人经验固化为新员工，替创建者承接重复工作，并通过员工档案管理能力与表现。</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">流</span><span>流程型技能</span></div><p>状态机驱动多个 SOP 实时切换，既保留工作流确定性，也保留 Agent 的灵活应对。</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">知</span><span>企业知识本体</span></div><p>把文档组织为可追溯的业务语义资产，让回答有依据，检索可调试。</p></div>
          </div>
        </section>
        <section id="reliability">
          <h2>三层可靠性</h2>
          <p>企业级 Agent 的关键不是“能回答”，而是能不能稳定承接真实工作。StaffDeck 用流程、知识、迭代三条主线解决流程不可控、知识不可溯、能力不可积累的问题。</p>
          <div class="card-group cols-3">
            <div class="doc-card"><div class="card-head"><span class="card-icon">1</span><span>流程可靠</span></div><p>SOP 以状态机方式执行，任务被打断后可以保存上下文并回到原节点继续。</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">2</span><span>知识可靠</span></div><p>回答关联来源、规则与业务主题，不只给结论，也能说明依据来自哪里。</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">3</span><span>迭代可靠</span></div><p>Trace、点赞差评与人工兜底形成闭环，让边界案例进入下一轮修订。</p></div>
          </div>
        </section>
        <section id="docs-map">
          <h2>文档地图</h2>
          <p>如果你第一次了解 StaffDeck，可以先读核心能力，再进入数字员工、流程型技能、知识库和 Trace 四个功能页，最后用快速开始在本地跑起 Web Demo。</p>
          <div class="card-group cols-3">
            <a class="doc-card" href="staffdeck_core.html"><div class="card-head"><span class="card-icon">能</span><span>核心能力</span></div><p>理解 StaffDeck 为什么不是普通聊天机器人，而是数字员工运营平台。</p></a>
            <a class="doc-card" href="staffdeck_employee.html"><div class="card-head"><span class="card-icon">员</span><span>数字员工管理</span></div><p>查看员工档案、岗位边界、能力看板、成长记录和员工广场。</p></a>
            <a class="doc-card" href="staffdeck_quick.html"><div class="card-head"><span class="card-icon">启</span><span>快速开始</span></div><p>克隆仓库，配置模型服务，在本地启动 StaffDeck Web Demo。</p></a>
          </div>
        </section>`,
      en: `
        <section id="intro">
          <h1>StaffDeck</h1>
          <p class="lead">StaffDeck is a full-cycle platform for building and operating digital employees.</p>
          <p>Over the past few years, organizations have purchased many AI tools, yet little capability has truly stayed inside the organization. Prompts live on personal laptops, workflows are scattered across documents, deployed agents rarely improve from feedback, and experts are still interrupted by repeated questions.</p>
          <p>StaffDeck approaches AI as a digital employee rather than another chatbot. Each agent has a role, an employee identity, capability boundaries, work records, and continuously maintainable SOPs, knowledge, tools, and Trace data.</p>
          <p class="strong-line">From workflow digitization to organizational intelligence, StaffDeck makes AI manageable, trustworthy, and accumulative.</p>
          <div class="screenshot"><img src="${asset("introduce-hero.png")}" alt="StaffDeck homepage"><div class="caption">StaffDeck Preview organizes employee plaza, capabilities, and business entry points.</div></div>
        </section>
        <section id="positioning">
          <h2>Positioning</h2>
          <p>StaffDeck is designed for organizations that want to move AI from individual productivity tools into reusable organizational capability. Experts can turn their experience, knowledge, and operating procedures into digital employees that handle repeated communication and standardized tasks.</p>
          <p>The platform covers the core chain from employee creation, process skills, enterprise knowledge ontology, tool access, scheduled tasks, conversation tracing, and feedback analysis. The Preview release is open source for local evaluation, secondary development, and real business validation.</p>
          <div class="card-group cols-3">
            <div class="doc-card"><div class="card-head"><span class="card-icon">E</span><span>Digital Employees</span></div><p>Turn personal expertise into new employees that can take over repeated work and expose capability through employee profiles.</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">P</span><span>Process Skills</span></div><p>State-machine SOPs switch across workflows in real time while preserving workflow determinism and agent flexibility.</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">K</span><span>Knowledge Ontology</span></div><p>Organize documents into traceable business semantics so answers have evidence and retrieval can be debugged.</p></div>
          </div>
        </section>
        <section id="reliability">
          <h2>Reliability Model</h2>
          <p>For enterprise agents, the key question is not whether they can answer, but whether they can reliably take on real work. StaffDeck uses three reliability layers to address uncontrollable processes, untraceable knowledge, and non-accumulating capability.</p>
          <div class="card-group cols-3">
            <div class="doc-card"><div class="card-head"><span class="card-icon">1</span><span>Reliable Process</span></div><p>SOPs run as state machines, so interrupted tasks can save context and resume from the original node.</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">2</span><span>Reliable Knowledge</span></div><p>Answers connect sources, rules, and business topics instead of returning conclusions without evidence.</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">3</span><span>Reliable Iteration</span></div><p>Trace, feedback, and human handoff create a loop that turns edge cases into future improvements.</p></div>
          </div>
        </section>
        <section id="docs-map">
          <h2>Documentation Map</h2>
          <p>If you are new to StaffDeck, start with Core Capabilities, then read the feature pages for digital employees, process skills, knowledge, and Trace. Finish with Quick Start to run the Web Demo locally.</p>
          <div class="card-group cols-3">
            <a class="doc-card" href="staffdeck_core.html"><div class="card-head"><span class="card-icon">C</span><span>Core Capabilities</span></div><p>Understand why StaffDeck is a digital employee operations platform, not a generic chatbot.</p></a>
            <a class="doc-card" href="staffdeck_employee.html"><div class="card-head"><span class="card-icon">E</span><span>Digital Employee Management</span></div><p>Review profiles, role boundaries, capability dashboards, growth records, and employee plaza.</p></a>
            <a class="doc-card" href="staffdeck_quick.html"><div class="card-head"><span class="card-icon">Q</span><span>Quick Start</span></div><p>Clone the repository, configure a model service, and start the StaffDeck Web Demo locally.</p></a>
          </div>
        </section>`,
    },
  },
  {
    id: "core",
    title: { zh: "核心能力", en: "Core Capabilities" },
    toc: {
      zh: [
        { id: "model", label: "能力模型" },
        { id: "flow", label: "业务链路" },
        { id: "open", label: "开源 Preview" },
      ],
      en: [
        { id: "model", label: "Capability Model" },
        { id: "flow", label: "Business Flow" },
        { id: "open", label: "Open Preview" },
      ],
    },
    content: {
      zh: `
        <section id="model">
          <h1>核心能力</h1>
          <p class="lead">StaffDeck 解决的不是“有没有 AI”，而是 AI 能力如何稳定地变成组织能力。</p>
          <p>在 StaffDeck 中，每个 Agent 都以数字员工的形式存在。它的能力不是一段提示词，而是一套可运营的资源组合：岗位档案、SOP、知识库、工具、记忆、定时任务、Trace 和反馈数据。</p>
          <div class="screenshot"><img src="${asset("capability-overview.png")}" alt="StaffDeck 数字员工能力总览"><div class="caption">数字员工的档案、能力模块和工作记录统一呈现，方便持续运营。</div></div>
          <div class="card-group cols-3">
            <div class="doc-card"><div class="card-head"><span class="card-icon">档</span><span>员工档案</span></div><p>姓名、岗位、工号、在线状态、对话量、好评率和成长记录构成管理入口。</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">S</span><span>SOP 状态机</span></div><p>把复杂流程拆成可执行节点，支持条件分支、工具调用、知识检索和转人工。</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">O</span><span>OKF 知识本体</span></div><p>用主题、规则、来源、操作手册等结构承载业务知识，回答可溯源。</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">工</span><span>工具接入</span></div><p>通过 HTTP API 与 MCP 接入企业系统，让数字员工不只回答问题，也能办事。</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">时</span><span>定时任务</span></div><p>支持每日、每周、每月和一次性任务，让数字员工主动执行周期性工作。</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">迹</span><span>Trace 反馈</span></div><p>完整记录路由、步骤、工具、知识和回复，把黑盒对话变成可复盘过程。</p></div>
          </div>
        </section>
        <section id="flow">
          <h2>业务链路</h2>
          <p>一次真实请求可能同时包含多个任务。例如“帮我报差旅费，顺便查一下这个月额度还剩多少”，数字员工需要先进入差旅报销 SOP，完成信息收集与规则判断，再切换到额度查询 SOP，调用企业接口返回结果。</p>
          <p>如果用户中途插问政策问题，StaffDeck 会保存当前流程状态，转入知识检索回答临时问题，再回到原流程节点继续。遇到超出规则边界的问题，则把上下文交还给创建者本人，避免无依据地强答。</p>
          <div class="note">可靠的数字员工不是永远给答案，而是在确定边界内稳定完成工作，在边界之外准确交还给人。</div>
        </section>
        <section id="open">
          <h2>开源 Preview</h2>
          <p>当前开源 Preview 版本开放数字员工创建、流程型技能、知识库、工具、定时任务、对话追踪与反馈等核心链路。仓库地址为 <a href="https://github.com/OpenBMB/URStaff" target="_blank" rel="noreferrer">OpenBMB/URStaff</a>。</p>
        </section>`,
      en: `
        <section id="model">
          <h1>Core Capabilities</h1>
          <p class="lead">StaffDeck is not about whether a company has AI. It is about making AI capability reliably become organizational capability.</p>
          <p>In StaffDeck, every agent exists as a digital employee. Its capability is not a single prompt, but an operable resource package: role profile, SOPs, knowledge base, tools, memory, scheduled tasks, Trace, and feedback data.</p>
          <div class="screenshot"><img src="${asset("capability-overview.png")}" alt="StaffDeck capability overview"><div class="caption">Profiles, capabilities, and work records are managed in one place for continuous operations.</div></div>
          <div class="card-group cols-3">
            <div class="doc-card"><div class="card-head"><span class="card-icon">P</span><span>Employee Profiles</span></div><p>Name, role, employee ID, online status, conversation volume, feedback rate, and growth records form the management entry point.</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">S</span><span>SOP State Machine</span></div><p>Complex procedures are broken into executable nodes with branches, tool calls, knowledge retrieval, and human handoff.</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">O</span><span>OKF Knowledge Ontology</span></div><p>Topics, rules, sources, and playbooks carry business knowledge and keep answers traceable.</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">T</span><span>Tool Access</span></div><p>HTTP APIs and MCP connect internal systems so digital employees can complete work, not only answer questions.</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">A</span><span>Scheduled Tasks</span></div><p>Daily, weekly, monthly, and one-off schedules let digital employees proactively run recurring work.</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">R</span><span>Trace and Feedback</span></div><p>Routing, steps, tools, knowledge, and responses are recorded so black-box conversations become reviewable processes.</p></div>
          </div>
        </section>
        <section id="flow">
          <h2>Business Flow</h2>
          <p>A real request may contain multiple tasks. For example, “help me submit last week’s travel reimbursement and check how much reimbursement quota remains this month” requires the employee to enter a reimbursement SOP, collect information, apply policy rules, then switch to a quota-query SOP and call an enterprise API.</p>
          <p>If the user interrupts with a policy question, StaffDeck saves the current process state, retrieves knowledge to answer the temporary question, and then returns to the original process node. If the question is outside the configured boundary, it hands the full context back to the creator instead of forcing an unsupported answer.</p>
          <div class="note">A reliable digital employee does not answer everything. It completes work within defined boundaries and hands uncertain cases back to people.</div>
        </section>
        <section id="open">
          <h2>Open Preview</h2>
          <p>The open-source Preview release includes the core chain for digital employee creation, process skills, knowledge base, tools, scheduled tasks, conversation tracing, and feedback. Repository: <a href="https://github.com/OpenBMB/URStaff" target="_blank" rel="noreferrer">OpenBMB/URStaff</a>.</p>
        </section>`,
    },
  },
  {
    id: "why",
    title: { zh: "为什么选择 StaffDeck", en: "Why StaffDeck" },
    toc: {
      zh: [
        { id: "problems", label: "三个问题" },
        { id: "answer", label: "StaffDeck 的回答" },
      ],
      en: [
        { id: "problems", label: "Three Problems" },
        { id: "answer", label: "StaffDeck's Answer" },
      ],
    },
    content: {
      zh: `
        <section id="problems">
          <h1>为什么选择 StaffDeck？</h1>
          <p class="lead">企业已经为 AI 付了很多钱，但能力常常没有留在组织里。</p>
          <div class="accordion-group">
            <div class="accordion-item"><div class="accordion-title">AI 能力是个人的，不是组织的</div><div class="accordion-body">提示词、工作流和业务判断散落在个人电脑与文档角落。员工离职或调岗后，这些积累对组织来说往往归零。</div></div>
            <div class="accordion-item"><div class="accordion-title">Agent 部署之后，就不再进化</div><div class="accordion-body">许多平台停留在配置完发布。上线后的对话、反馈和边界案例没有进入改进机制，第一天和一年后差别不大。</div></div>
            <div class="accordion-item"><div class="accordion-title">专业员工被重复问题拖住</div><div class="accordion-body">报销流程、制度咨询、合规判断等问题不难，但量大。真正需要判断力的工作反而被挤压。</div></div>
          </div>
        </section>
        <section id="answer">
          <h2>StaffDeck 的回答</h2>
          <p>StaffDeck 把专业员工的经验、判断标准和操作流程固化为数字员工，像老员工带新人一样，把方法论传授给一位可以 7x24 小时在线、不会遗忘、可以持续被打磨的新同事。</p>
          <div class="card-group cols-3">
            <div class="doc-card"><div class="card-head"><span class="card-icon">工</span><span>从工具到员工</span></div><p>AI 不只是等待提问，而是承担明确岗位职责与工作任务。</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">运</span><span>从静态到运营</span></div><p>对话、反馈和边界案例都能转化为后续改进依据。</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">资</span><span>从个人到资产</span></div><p>最了解业务的人可以亲手创建数字员工，并把成熟能力开放给更多同事使用。</p></div>
          </div>
        </section>`,
      en: `
        <section id="problems">
          <h1>Why StaffDeck?</h1>
          <p class="lead">Many organizations have paid for AI, but the capability often does not stay inside the organization.</p>
          <div class="accordion-group">
            <div class="accordion-item"><div class="accordion-title">AI capability remains personal, not organizational</div><div class="accordion-body">Prompts, workflows, and business judgment are scattered across personal machines and documents. When an employee leaves or changes roles, these assets often disappear for the organization.</div></div>
            <div class="accordion-item"><div class="accordion-title">Agents stop improving after deployment</div><div class="accordion-body">Many platforms stop at “configure and publish.” Conversations, feedback, and boundary cases from production use never enter an improvement mechanism.</div></div>
            <div class="accordion-item"><div class="accordion-title">Experts are trapped by repeated questions</div><div class="accordion-body">Expense processes, policy questions, and compliance judgments may be simple, but the volume is high. Work that needs real judgment gets squeezed out.</div></div>
          </div>
        </section>
        <section id="answer">
          <h2>StaffDeck's Answer</h2>
          <p>StaffDeck turns expert experience, judgment standards, and operating procedures into digital employees. Like an experienced employee training a new colleague, the expert can pass methods to a new teammate that is always online, never forgets, and can be continuously refined.</p>
          <div class="card-group cols-3">
            <div class="doc-card"><div class="card-head"><span class="card-icon">T</span><span>From Tool to Employee</span></div><p>AI no longer only waits for questions; it owns clear responsibilities and work tasks.</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">O</span><span>From Static Release to Operations</span></div><p>Conversations, feedback, and boundary cases become evidence for later improvement.</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">A</span><span>From Personal Know-how to Assets</span></div><p>The people closest to the business can create digital employees and share mature capabilities with colleagues.</p></div>
          </div>
        </section>`,
    },
  },
  {
    id: "quick",
    title: { zh: "快速开始", en: "Quick Start" },
    toc: {
      zh: [
        { id: "requirements", label: "环境要求" },
        { id: "install", label: "克隆并安装" },
        { id: "model", label: "配置模型" },
        { id: "run", label: "启动 Web Demo" },
        { id: "verify", label: "验证安装" },
        { id: "commands", label: "常用命令" },
      ],
      en: [
        { id: "requirements", label: "Requirements" },
        { id: "install", label: "Clone and Install" },
        { id: "model", label: "Configure the Model" },
        { id: "run", label: "Start the Web Demo" },
        { id: "verify", label: "Verify" },
        { id: "commands", label: "Common Commands" },
      ],
    },
    content: {
      zh: `
        <section id="requirements">
          <h1>快速开始</h1>
          <p class="lead">按照下面的步骤在本地启动 StaffDeck Web Demo，并连接一个 OpenAI Chat Completions 兼容的模型服务。</p>
          <h2>环境要求</h2>
          <ul class="requirement-list"><li>使用开发脚本时需要 macOS、Linux 或 WSL</li><li>Python <strong>3.11+</strong></li><li>Node.js <strong>20+</strong> 与 npm</li><li>OpenAI Chat Completions 兼容的模型接口和 API Key</li><li>应用本身不要求 CUDA；硬件要求由所选择的模型服务决定</li></ul>
        </section>
        <section id="install"><h2>1. 克隆并安装</h2><pre class="code-block" data-language="bash"><code>git clone https://github.com/OpenBMB/URStaff.git
cd StaffDeck

python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -e "backend[dev]"
npm --prefix frontend-enterprise ci
cp backend/.env.example backend/.env</code></pre></section>
        <section id="model"><h2>2. 配置模型</h2><p>首次启动前编辑 <code>backend/.env</code>：</p><pre class="code-block" data-language="dotenv"><code>APP_SECRET="请替换为足够长的随机字符串"
DEMO_MODEL_BASE_URL="https://你的OpenAI兼容接口/v1"
DEMO_MODEL_NAME="你的模型名"
DEMO_MODEL_API_KEY="你的API-Key"</code></pre><div class="note">API Key 用于创建初始模型配置，存入数据库前会被加密。请勿提交 <code>backend/.env</code>。服务启动后也可以在 <strong>管理员 → 模型配置</strong> 中管理模型服务。</div></section>
        <section id="run"><h2>3. 启动 Web Demo</h2><pre class="code-block" data-language="bash"><code>DETACH=1 scripts/dev_up.sh</code></pre><p>脚本会构建 StaffDeck 前端，并由一个 FastAPI 进程在 <code>5173</code> 端口同时提供 UI、API 与 Swagger 文档。</p></section>
        <section id="verify"><h2>4. 验证安装</h2><pre class="code-block" data-language="bash"><code>curl http://127.0.0.1:5173/api/health</code></pre><p>预期输出：</p><pre class="code-block" data-language="json"><code>{"status":"ok"}</code></pre><p>打开 <a href="http://127.0.0.1:5173/workspace/gallery">http://127.0.0.1:5173/workspace/gallery</a>，选择一个数字员工并发送首条消息。回答和执行记录应该在同一个对话轮次中流式显示。</p></section>
        <section id="commands"><h2>常用命令</h2><pre class="code-block" data-language="bash"><code>scripts/dev_status.sh       # 查看服务状态
scripts/dev_down.sh         # 停止本地服务
scripts/dev_up.sh           # 前台运行</code></pre></section>`,
      en: `
        <section id="requirements">
          <h1>Quick Start</h1>
          <p class="lead">Follow these steps to start the StaffDeck Web Demo locally and connect it to an OpenAI Chat Completions-compatible model service.</p>
          <h2>Requirements</h2>
          <ul class="requirement-list"><li>macOS, Linux, or WSL when using the development scripts</li><li>Python <strong>3.11+</strong></li><li>Node.js <strong>20+</strong> and npm</li><li>An OpenAI Chat Completions-compatible model endpoint and API key</li><li>StaffDeck itself does not require CUDA; hardware requirements depend on the selected model service</li></ul>
        </section>
        <section id="install"><h2>1. Clone and Install</h2><pre class="code-block" data-language="bash"><code>git clone https://github.com/OpenBMB/URStaff.git
cd StaffDeck
python3 -m venv backend/.venv
backend/.venv/bin/python -m pip install -e "backend[dev]"
npm --prefix frontend-enterprise ci
cp backend/.env.example backend/.env</code></pre></section>
        <section id="model"><h2>2. Configure the Model</h2><p>Before the first launch, edit <code>backend/.env</code>:</p><pre class="code-block" data-language="dotenv"><code>APP_SECRET="replace-with-a-long-random-string"
DEMO_MODEL_BASE_URL="https://your-openai-compatible-endpoint/v1"
DEMO_MODEL_NAME="your-model-name"
DEMO_MODEL_API_KEY="your-api-key"</code></pre><div class="note">The API key is used to create the initial model configuration and is encrypted before being stored in the database. Do not commit <code>backend/.env</code>. After the service starts, model services can also be managed from <strong>Admin → Model Configuration</strong>.</div></section>
        <section id="run"><h2>3. Start the Web Demo</h2><pre class="code-block" data-language="bash"><code>DETACH=1 scripts/dev_up.sh</code></pre><p>The script builds the StaffDeck frontend and serves the UI, API, and Swagger docs from one FastAPI process on port <code>5173</code>.</p></section>
        <section id="verify"><h2>4. Verify the Installation</h2><pre class="code-block" data-language="bash"><code>curl http://127.0.0.1:5173/api/health</code></pre><p>Expected output:</p><pre class="code-block" data-language="json"><code>{"status":"ok"}</code></pre><p>Open <a href="http://127.0.0.1:5173/workspace/gallery">http://127.0.0.1:5173/workspace/gallery</a>, choose a digital employee, and send the first message. The answer and execution trace should stream in the same conversation turn.</p></section>
        <section id="commands"><h2>Common Commands</h2><pre class="code-block" data-language="bash"><code>scripts/dev_status.sh       # Show service status
scripts/dev_down.sh         # Stop local services
scripts/dev_up.sh           # Run in the foreground</code></pre></section>`,
    },
  },
  {
    id: "employee",
    title: { zh: "数字员工管理", en: "Digital Employee Management" },
    toc: {
      zh: [
        { id: "profile", label: "员工档案" },
        { id: "dashboard", label: "能力看板" },
        { id: "gallery", label: "员工广场" },
      ],
      en: [
        { id: "profile", label: "Employee Profile" },
        { id: "dashboard", label: "Capability Dashboard" },
        { id: "gallery", label: "Employee Plaza" },
      ],
    },
    content: {
      zh: `
        <section id="profile">
          <h1>数字员工管理</h1>
          <p class="lead">数字员工是 StaffDeck 的核心组织单元，用管理真人员工的方式管理 AI。</p>
          <p>每一个 AI Agent 在系统中都有姓名、头像、岗位角色和工号，并随时展示当前在线状态。创建者可以定义岗位边界、服务风格和能力范围，让数字员工在清晰职责内工作。</p>
          <div class="screenshot"><img src="${asset("employee-profile.png")}" alt="StaffDeck 数字员工档案"><div class="caption">员工档案集中展示岗位、能力模块、工作记录和反馈指标。</div></div>
        </section>
        <section id="dashboard">
          <h2>能力看板</h2>
          <p>员工档案页展示工作记录热力图、历史对话轮次、好评率、差评率等关键绩效指标。能力看板聚合技能数量、流程数量、知识资料、工具数量和自动任务，让管理者快速判断能力边界。</p>
          <div class="card-group cols-3">
            <div class="doc-card"><div class="card-head"><span class="card-icon">绩</span><span>绩效可见</span></div><p>对话量、反馈率和工作记录形成持续观察面，不再只靠主观体验判断 AI 效果。</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">界</span><span>边界清晰</span></div><p>SOP、知识、工具和任务被聚合展示，帮助判断能做什么、不能做什么。</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">长</span><span>成长可追踪</span></div><p>每次新增技能、流程、知识库或工具都会进入成长记录，方便复盘迭代。</p></div>
          </div>
        </section>
        <section id="gallery">
          <h2>员工广场</h2>
          <p>每个账号都可以创建和管理自己的数字员工。调试成熟后，创建者可以将员工发布到广场，其他同事直接选用，无需重复搭建相同能力。</p>
          <div class="screenshot"><img src="${asset("employee-create.png")}" alt="StaffDeck 新建数字员工"><div class="caption">从空白创建或从广场复制，让个人经验逐步变成可复用的组织能力。</div></div>
        </section>`,
      en: `
        <section id="profile">
          <h1>Digital Employee Management</h1>
          <p class="lead">Digital employees are the core operating unit in StaffDeck. AI is managed in a way that resembles managing real employees.</p>
          <p>Each AI agent has a name, avatar, role, and employee ID, and shows its current online status. Creators can define role boundaries, service style, and capability scope so the employee works inside clear responsibilities.</p>
          <div class="screenshot"><img src="${asset("employee-profile.png")}" alt="StaffDeck employee profile"><div class="caption">Employee profiles centralize role, capability modules, work records, and feedback metrics.</div></div>
        </section>
        <section id="dashboard">
          <h2>Capability Dashboard</h2>
          <p>The employee profile shows work-record heatmaps, historical conversation rounds, positive feedback rate, negative feedback rate, and other key performance indicators. The capability dashboard summarizes skills, processes, knowledge assets, tools, and scheduled tasks so managers can quickly understand capability boundaries.</p>
          <div class="card-group cols-3">
            <div class="doc-card"><div class="card-head"><span class="card-icon">P</span><span>Visible Performance</span></div><p>Conversation volume, feedback rates, and work records create a continuous view instead of vague AI evaluation.</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">B</span><span>Clear Boundaries</span></div><p>SOPs, knowledge, tools, and tasks are summarized so teams know what the employee can and cannot do.</p></div>
            <div class="doc-card"><div class="card-head"><span class="card-icon">G</span><span>Trackable Growth</span></div><p>New skills, processes, knowledge bases, and tools enter growth records for later review.</p></div>
          </div>
        </section>
        <section id="gallery">
          <h2>Employee Plaza</h2>
          <p>Each account can create and manage its own digital employees. Once an employee is mature, the creator can publish it to the plaza so colleagues can reuse it without rebuilding the same capability.</p>
          <div class="screenshot"><img src="${asset("employee-create.png")}" alt="Create a StaffDeck digital employee"><div class="caption">Create from scratch or copy from the plaza so personal expertise gradually becomes reusable organizational capability.</div></div>
        </section>`,
    },
  },
  {
    id: "sop",
    title: { zh: "流程型技能", en: "Process Skills" },
    toc: {
      zh: [
        { id: "engine", label: "执行引擎" },
        { id: "distill", label: "自然语言生成" },
        { id: "version", label: "版本与分支" },
      ],
      en: [
        { id: "engine", label: "Execution Engine" },
        { id: "distill", label: "Natural Language Generation" },
        { id: "version", label: "Versions and Branches" },
      ],
    },
    content: {
      zh: `
        <section id="engine">
          <h1>流程型技能</h1>
          <p class="lead">SOP 是数字员工执行任务的核心驱动力，定义遇到某类任务时按什么步骤、在什么条件下、调用哪些工具、检索哪些知识、做出什么判断。</p>
          <p>纯技能方案灵活但容易在复杂流程中混淆；纯工作流方案准确但会把 Agent 绑定在单一流程上。StaffDeck 的流程型技能以技能方式接入数字员工，同时用状态机实现工作流的准确执行。</p>
          <div class="screenshot"><img src="${asset("sop-list.png")}" alt="StaffDeck SOP 管理列表"><div class="caption">流程型技能让数字员工既能遵循确定流程，也能处理中途插问和多任务切换。</div></div>
        </section>
        <section id="distill">
          <h2>自然语言生成流程</h2>
          <p>业务人员可以直接描述处理逻辑，例如“当用户咨询合同审批流程时，先判断合同金额，50 万以下走 A 通道，50 万以上走 B 通道，同时检索法务知识库”。StaffDeck 会自动蒸馏为结构化流程，包含步骤节点、判断分支、工具调用节点和知识检索节点。</p>
          <div class="screenshot"><img src="${asset("sop-editor.png")}" alt="StaffDeck SOP 可视化编辑器"><div class="caption">生成后的流程可在可视化编辑器中继续修改节点、分支、工具绑定与知识范围。</div></div>
        </section>
        <section id="version">
          <h2>版本与分支</h2>
          <p>每次流程修改都会生成新版本，可随时回滚。不同部门的数字员工可以持有同一流程的不同分支，从同一个基础流程出发，演化出符合本部门业务逻辑的变体。</p>
          <div class="screenshot"><img src="${asset("sop-list.png")}" alt="StaffDeck SOP 管理列表"><div class="caption">流程列表展示调用次数、好评率、差评率和待改进状态，为迭代提供依据。</div></div>
        </section>`,
      en: `
        <section id="engine">
          <h1>Process Skills</h1>
          <p class="lead">SOPs are the execution engine for digital employees. They define what steps to follow, under what conditions, which tools to call, which knowledge to retrieve, and what judgments to make.</p>
          <p>Pure skill-based agents are flexible but often confuse complex procedures. Pure workflows are accurate but bind an agent to a single flow. StaffDeck connects process skills to employees as skills while using a state machine to execute workflows accurately.</p>
          <div class="screenshot"><img src="${asset("sop-list.png")}" alt="StaffDeck SOP management"><div class="caption">Process skills let digital employees follow deterministic procedures while handling interruptions and multi-task switching.</div></div>
        </section>
        <section id="distill">
          <h2>Natural Language Generation</h2>
          <p>Business users can describe operating logic directly. For example: “When a user asks about contract approval, first check the contract amount; under 500k goes through channel A, above 500k goes through channel B, and retrieve the legal knowledge base.” StaffDeck distills this into a structured process with steps, branches, tool calls, and knowledge retrieval nodes.</p>
          <div class="screenshot"><img src="${asset("sop-editor.png")}" alt="StaffDeck SOP visual editor"><div class="caption">Generated processes can be edited visually for nodes, branches, tool bindings, and knowledge scopes.</div></div>
        </section>
        <section id="version">
          <h2>Versions and Branches</h2>
          <p>Every process edit creates a new version that can be rolled back. Different departments can hold different branches of the same process, starting from a shared base while evolving department-specific variants.</p>
          <div class="screenshot"><img src="${asset("sop-list.png")}" alt="StaffDeck SOP list"><div class="caption">The process list shows calls, positive feedback, negative feedback, and improvement status to support iteration.</div></div>
        </section>`,
    },
  },
  {
    id: "knowledge",
    title: { zh: "企业知识本体", en: "Enterprise Knowledge Ontology" },
    toc: {
      zh: [
        { id: "ontology", label: "知识本体" },
        { id: "buckets", label: "知识分桶" },
        { id: "debug", label: "检索调试" },
      ],
      en: [
        { id: "ontology", label: "Ontology" },
        { id: "buckets", label: "Knowledge Buckets" },
        { id: "debug", label: "Retrieval Debugging" },
      ],
    },
    content: {
      zh: `
        <section id="ontology">
          <h1>企业本体与知识库</h1>
          <p class="lead">StaffDeck 的知识库不是“上传文档 + 向量检索”，而是一套带业务语义的企业知识本体。</p>
          <p>基于 OKF 思路，知识被组织为带有结构化标注的语义资产。数字员工检索到的，不只是几段文本，而是规则、流程、主题、来源与角色之间的关系。</p>
          <div class="screenshot"><img src="${asset("knowledge-library.png")}" alt="StaffDeck 知识库管理"><div class="caption">知识从散落文档升级为主题、规则、操作手册和来源之间的语义结构。</div></div>
        </section>
        <section id="buckets">
          <h2>知识分桶与来源溯源</h2>
          <p>平台支持 Source Document、Topic、Playbook、Business Rule、Query Analysis 等概念类型。知识可以按主题、业务线和职责分桶，不同数字员工调用不同知识范围，减少串扰。</p>
          <div class="screenshot"><img src="${asset("knowledge-detail.png")}" alt="StaffDeck 知识详情与引用来源"><div class="caption">知识库列表、引用数量和版本分支让企业知识可管理、可治理。</div></div>
        </section>
        <section id="debug">
          <h2>检索调试</h2>
          <p>管理员可以直接输入问题，实时查看命中了哪些知识片段、来自哪些文档、相关度如何。知识与流程也会深度打通，SOP 每个步骤都可以配置优先检索的知识分桶。</p>
          <div class="screenshot"><img src="${asset("knowledge-library.png")}" alt="StaffDeck 知识库列表与知识图谱"><div class="caption">回答能够回到原始文档、章节切片和业务上下文，方便核验与审计。</div></div>
        </section>`,
      en: `
        <section id="ontology">
          <h1>Enterprise Ontology and Knowledge Base</h1>
          <p class="lead">StaffDeck knowledge is not “document upload plus vector retrieval,” but an enterprise ontology with business semantics.</p>
          <p>Following the OKF idea, knowledge is organized as semantic assets with structured annotations. Digital employees retrieve not just text fragments, but relationships among rules, processes, topics, sources, and roles.</p>
          <div class="screenshot"><img src="${asset("knowledge-library.png")}" alt="StaffDeck knowledge management"><div class="caption">Knowledge moves from scattered documents into semantic structures of topics, rules, playbooks, and sources.</div></div>
        </section>
        <section id="buckets">
          <h2>Knowledge Buckets and Source Tracing</h2>
          <p>The platform supports concept types such as Source Document, Topic, Playbook, Business Rule, and Query Analysis. Knowledge can be bucketed by topic, business line, and responsibility so different employees search within different scopes and reduce interference.</p>
          <div class="screenshot"><img src="${asset("knowledge-detail.png")}" alt="StaffDeck knowledge details and references"><div class="caption">Knowledge lists, reference counts, and version branches make enterprise knowledge manageable and governable.</div></div>
        </section>
        <section id="debug">
          <h2>Retrieval Debugging</h2>
          <p>Administrators can enter a question and inspect which knowledge slices were retrieved, from which documents, and with what relevance. Knowledge and process are also connected: each SOP step can specify preferred knowledge buckets for retrieval.</p>
          <div class="screenshot"><img src="${asset("knowledge-library.png")}" alt="StaffDeck knowledge list and graph"><div class="caption">Answers can be traced back to original documents, sections, and business context for verification and audit.</div></div>
        </section>`,
    },
  },
  {
    id: "ops",
    title: { zh: "自动任务与 Trace", en: "Scheduled Tasks and Trace" },
    toc: {
      zh: [
        { id: "scheduled", label: "自动任务" },
        { id: "trace", label: "Trace 闭环" },
        { id: "handoff", label: "人工兜底" },
      ],
      en: [
        { id: "scheduled", label: "Scheduled Tasks" },
        { id: "trace", label: "Trace Loop" },
        { id: "handoff", label: "Human Handoff" },
      ],
    },
    content: {
      zh: `
        <section id="scheduled">
          <h1>自动任务与 Trace 闭环</h1>
          <p class="lead">数字员工不只被动等待用户发起对话，也可以按计划主动工作。</p>
          <p>自动任务支持每日、每周、每月和一次性调度，适合业务数据摘要、周报整理、合规检查、客户回访提醒等周期性任务。用户也可以在对话中用自然语言创建任务，例如“帮我每天早上九点把昨天的销售数据发给我”。</p>
          <div class="screenshot"><img src="${asset("feedback-list.png")}" alt="StaffDeck 对话日志与反馈列表"><div class="caption">数字员工的对话、反馈与任务状态会进入可复盘的运营视图。</div></div>
        </section>
        <section id="trace">
          <h2>Trace 闭环</h2>
          <p>完整 Trace 记录路由决策、步骤执行、工具调用、知识检索、反思和最终回复。管理员可以定位问题到底来自知识缺口、流程分支、工具失败还是模型回复，并据此修订 SOP 或补充知识库。</p>
          <div class="screenshot"><img src="${asset("trace-detail.png")}" alt="StaffDeck 对话 Trace 详情"><div class="caption">执行记录让一次回复背后的路由、工具和流程节点变得可解释。</div></div>
        </section>
        <section id="handoff">
          <h2>人工兜底</h2>
          <p>遇到超出规则边界的问题，数字员工不会强行编造答案，而是把完整上下文交还给创建者本人。人工补充回答后，这类新经验可以进入流程或知识库，让数字员工下一次自己处理。</p>
          <div class="note">Trace 与反馈不是“日志留存”，而是数字员工持续运营和越用越强的基础。</div>
        </section>`,
      en: `
        <section id="scheduled">
          <h1>Scheduled Tasks and Trace Loop</h1>
          <p class="lead">Digital employees do not only wait for conversations. They can also work proactively on schedule.</p>
          <p>Scheduled tasks support daily, weekly, monthly, and one-off runs for recurring work such as business data summaries, weekly reports, compliance checks, and customer follow-up reminders. Users can also create tasks in natural language during a conversation, such as “send me yesterday’s sales data every morning at 9.”</p>
          <div class="screenshot"><img src="${asset("feedback-list.png")}" alt="StaffDeck conversation logs and feedback"><div class="caption">Conversation, feedback, and task status enter an operations view that can be reviewed.</div></div>
        </section>
        <section id="trace">
          <h2>Trace Loop</h2>
          <p>Full Trace records routing decisions, step execution, tool calls, knowledge retrieval, reflection, and final responses. Administrators can locate whether a problem comes from a knowledge gap, process branch, tool failure, or model response, then revise SOPs or enrich the knowledge base.</p>
          <div class="screenshot"><img src="${asset("trace-detail.png")}" alt="StaffDeck conversation Trace details"><div class="caption">Execution records make routing, tools, and process nodes behind an answer explainable.</div></div>
        </section>
        <section id="handoff">
          <h2>Human Handoff</h2>
          <p>When a problem exceeds the configured rule boundary, the digital employee does not invent an answer. It hands the full context back to the creator. After the human adds an answer, that new experience can be added to the process or knowledge base so the employee can handle it next time.</p>
          <div class="note">Trace and feedback are not just logs. They are the foundation for operating digital employees and making them stronger through use.</div>
        </section>`,
    },
  },
  {
    id: "handover",
    title: { zh: "经验继承", en: "Knowledge Handover" },
    toc: {
      zh: [
        { id: "scenario", label: "场景" },
        { id: "flow", label: "沉淀流程" },
      ],
      en: [
        { id: "scenario", label: "Scenario" },
        { id: "flow", label: "Handover Flow" },
      ],
    },
    content: {
      zh: `
        <section id="scenario"><h1>经验继承</h1><p class="lead">当资深员工离职、调岗或扩岗时，企业最容易丢失的是判断方法。</p><p>StaffDeck 可以把合规、财务、教务、售后等岗位的规则、流程、文档和系统接口沉淀为数字员工，让经验从个人交接变成可持续运营的组织资产。</p></section>
        <section id="flow"><h2>沉淀流程</h2><div class="quickstart"><ol><li>整理高频任务、判断规则和关键文档。</li><li>创建数字员工并配置岗位、知识库、SOP 与工具。</li><li>通过真实问答和 Trace 修订边界案例，直到能稳定承接一线问题。</li></ol></div></section>`,
      en: `
        <section id="scenario"><h1>Knowledge Handover</h1><p class="lead">When senior employees leave, change roles, or take on broader responsibilities, the hardest thing to preserve is their judgment.</p><p>StaffDeck can turn rules, processes, documents, and system interfaces from compliance, finance, academic affairs, after-sales support, and other roles into digital employees. Experience moves from personal handover into durable organizational capability.</p></section>
        <section id="flow"><h2>Handover Flow</h2><div class="quickstart"><ol><li>Collect high-frequency tasks, judgment rules, and key documents.</li><li>Create a digital employee and configure its role, knowledge base, SOPs, and tools.</li><li>Use real conversations and Trace to refine boundary cases until the employee can reliably handle frontline questions.</li></ol></div></section>`,
    },
  },
  {
    id: "qa",
    title: { zh: "重复问答分担", en: "High-volume Q&A" },
    toc: {
      zh: [
        { id: "scenario", label: "场景" },
        { id: "impact", label: "效果" },
      ],
      en: [
        { id: "scenario", label: "Scenario" },
        { id: "impact", label: "Impact" },
      ],
    },
    content: {
      zh: `
        <section id="scenario"><h1>重复问答分担</h1><p class="lead">专业员工被大量高频咨询占用时，数字同事可以先接住标准化问题。</p><p>例如报销政策、招生咨询、员工制度、售后排查等场景，StaffDeck 通过知识库、流程型技能和工具调用，让数字员工先完成信息收集、规则判断和标准回复。</p></section>
        <section id="impact"><h2>效果</h2><div class="card-group cols-3"><div class="doc-card"><div class="card-head"><span class="card-icon">减</span><span>减少打断</span></div><p>让专家从重复解释中解放出来。</p></div><div class="doc-card"><div class="card-head"><span class="card-icon">准</span><span>回答一致</span></div><p>标准规则通过知识库和 SOP 管理。</p></div><div class="doc-card"><div class="card-head"><span class="card-icon">升</span><span>持续优化</span></div><p>差评和 Trace 会暴露知识缺口。</p></div></div></section>`,
      en: `
        <section id="scenario"><h1>High-volume Q&A</h1><p class="lead">When experts are occupied by repeated high-frequency questions, a digital colleague can handle standardized requests first.</p><p>For expense policies, admissions questions, employee policies, after-sales triage, and similar scenarios, StaffDeck combines knowledge base, process skills, and tool calls so digital employees can collect information, apply rules, and provide consistent responses.</p></section>
        <section id="impact"><h2>Impact</h2><div class="card-group cols-3"><div class="doc-card"><div class="card-head"><span class="card-icon">F</span><span>Fewer Interruptions</span></div><p>Experts regain time from repeated explanations and can focus on complex work.</p></div><div class="doc-card"><div class="card-head"><span class="card-icon">C</span><span>Consistent Answers</span></div><p>Standard rules are managed through knowledge bases and SOPs, reducing inconsistent replies.</p></div><div class="doc-card"><div class="card-head"><span class="card-icon">I</span><span>Continuous Improvement</span></div><p>Negative feedback and Trace reveal knowledge gaps for the next iteration.</p></div></div></section>`,
    },
  },
  {
    id: "proactive",
    title: { zh: "主动工作", en: "Proactive Work" },
    toc: {
      zh: [
        { id: "scenario", label: "场景" },
        { id: "examples", label: "任务例子" },
      ],
      en: [
        { id: "scenario", label: "Scenario" },
        { id: "examples", label: "Task Examples" },
      ],
    },
    content: {
      zh: `
        <section id="scenario"><h1>主动工作</h1><p class="lead">数字员工可以从被动回答，进一步变成按时执行的业务助手。</p><p>项目周报、数据汇总、合规检查、客户回访提醒等周期性工作，可以由数字员工按计划执行并主动推送结果。</p></section>
        <section id="examples"><h2>任务例子</h2><div class="card-group cols-3"><div class="doc-card"><div class="card-head"><span class="card-icon">报</span><span>周报生成</span></div><p>每周固定汇总项目状态、风险和待办。</p></div><div class="doc-card"><div class="card-head"><span class="card-icon">查</span><span>合规巡检</span></div><p>按规则检查业务数据，发现异常后生成处理建议。</p></div><div class="doc-card"><div class="card-head"><span class="card-icon">推</span><span>主动提醒</span></div><p>根据日程、状态或数据变化提醒相关人员。</p></div></div></section>`,
      en: `
        <section id="scenario"><h1>Proactive Work</h1><p class="lead">Digital employees can move beyond passive answers and become scheduled business assistants.</p><p>Recurring work such as project weekly reports, data summaries, compliance checks, and customer follow-up reminders can be executed on schedule and pushed to the right people.</p></section>
        <section id="examples"><h2>Task Examples</h2><div class="card-group cols-3"><div class="doc-card"><div class="card-head"><span class="card-icon">R</span><span>Weekly Reports</span></div><p>Summarize project status, risks, and action items every week for owners.</p></div><div class="doc-card"><div class="card-head"><span class="card-icon">C</span><span>Compliance Checks</span></div><p>Inspect business data according to rules and generate handling suggestions when anomalies appear.</p></div><div class="doc-card"><div class="card-head"><span class="card-icon">N</span><span>Proactive Reminders</span></div><p>Remind relevant people of next steps based on schedules, states, or data changes.</p></div></div></section>`,
    },
  },
] as const;
