from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import timedelta
from string import Formatter
from types import MappingProxyType

from sqlalchemy import or_, update
from sqlmodel import Session, select

from app.channels.service_identity import channel_label
from app.db.models import (
    AgentProfile,
    ChannelBinding,
    ChannelBindingAgent,
    ChannelConvState,
    utc_now,
)
from app.i18n.language_context import (
    LanguageContext,
    SupportedLocale,
    resolve_compatible_language_context,
)

COMMAND_PREFIX = "/"


@dataclass(frozen=True)
class ChannelNotice:
    """Carry one stable channel-owned notice code plus raw interpolation parameters."""

    code: str
    params: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        """Freeze a defensive parameter copy so asynchronous rendering cannot drift."""
        object.__setattr__(self, "params", MappingProxyType(dict(self.params)))


_NOTICE_TEXT: dict[str, dict[SupportedLocale, str]] = {
    "routing.help": {
        SupportedLocale.ZH_CN: (
            "可用指令：\n"
            "/员工 查看可调度员工列表\n"
            "/切换 <名字> 切换到指定员工\n"
            "/当前 查看当前员工\n"
            "/回复反馈 <内容> 回复人工转接通知\n"
            "/绑定 <绑定码> 把{channel_name}账号绑定到你的 StaffDeck 账号\n"
            "/解绑 解除{channel_name}账号与 StaffDeck 账号的绑定\n"
            "/帮助 查看本说明"
        ),
        SupportedLocale.EN_US: (
            "Available commands:\n"
            "/list List available employees\n"
            "/switch <name> Switch to an employee\n"
            "/current Show the current employee\n"
            "/handoff_reply <text> Reply to a human handoff notice\n"
            "/bind <code> Link this {channel_name} account to StaffDeck\n"
            "/unbind Unlink this {channel_name} account from StaffDeck\n"
            "/help Show this help"
        ),
    },
    "routing.current": {
        SupportedLocale.ZH_CN: "当前员工：「{agent_name}」。输入 /员工 查看可调度列表。",
        SupportedLocale.EN_US: "Current employee: {agent_name}. Enter /list to view available employees.",
    },
    "routing.switch_usage": {
        SupportedLocale.ZH_CN: "用法：/切换 <员工名字>。输入 /员工 查看可调度列表。",
        SupportedLocale.EN_US: "Usage: /switch <employee name>. Enter /list to view available employees.",
    },
    "routing.not_found": {
        SupportedLocale.ZH_CN: "没有找到员工「{query}」。输入 /员工 查看可调度列表。",
        SupportedLocale.EN_US: "No employee named {query} was found. Enter /list to view available employees.",
    },
    "routing.already_current": {
        SupportedLocale.ZH_CN: "当前已经是「{agent_name}」。",
        SupportedLocale.EN_US: "{agent_name} is already the current employee.",
    },
    "routing.switched": {
        SupportedLocale.ZH_CN: "已切换到「{agent_name}」，后续消息由 TA 回复。上下文各自独立，输入 /员工 查看列表。",
        SupportedLocale.EN_US: "Switched to {agent_name}. Future messages will be handled by this employee in an independent context. Enter /list to view all employees.",
    },
    "routing.auto_switched": {
        SupportedLocale.ZH_CN: "已为你转接「{agent_name}」，输入 /员工 查看全部",
        SupportedLocale.EN_US: "Routed to {agent_name}. Enter /list to view all employees.",
    },
    "routing.pointer_reset": {
        SupportedLocale.ZH_CN: "当前员工已下线，已为你切回默认员工「{agent_name}」。",
        SupportedLocale.EN_US: "The current employee is offline. Switched back to the default employee, {agent_name}.",
    },
    "system.error": {
        SupportedLocale.ZH_CN: "处理出错，请稍后再试。",
        SupportedLocale.EN_US: "Something went wrong. Please try again later.",
    },
    "system.interrupted": {
        SupportedLocale.ZH_CN: "上一条消息处理中断，请重新发送。",
        SupportedLocale.EN_US: "The previous message was interrupted. Please send it again.",
    },
    "team.commands_unavailable": {
        SupportedLocale.ZH_CN: "该渠道已接入团队，消息由团队 TL 统一接收，员工切换类指令不可用。",
        SupportedLocale.EN_US: "This channel is connected to a team. Messages are handled by the team lead, so employee-switching commands are unavailable.",
    },
    "team.inactive": {
        SupportedLocale.ZH_CN: "该渠道绑定的团队已解散或停用，请联系管理员调整渠道绑定。",
        SupportedLocale.EN_US: "The team linked to this channel is inactive or no longer exists. Ask an administrator to update the channel binding.",
    },
    "team.leader_missing": {
        SupportedLocale.ZH_CN: "团队「{team_name}」暂未设置 TL，请先在 StaffDeck 网页端设置 TL 后再试。",
        SupportedLocale.EN_US: "Team {team_name} does not have a team lead. Set one in StaffDeck and try again.",
    },
    "handoff.already_processed": {
        SupportedLocale.ZH_CN: "该人工转接请求已处理，无需再次回复。",
        SupportedLocale.EN_US: "This human handoff request has already been handled. No further reply is needed.",
    },
    "handoff.text_required": {
        SupportedLocale.ZH_CN: "请以文字内容回复本条通知消息，作为人工答复。",
        SupportedLocale.EN_US: "Reply to this notice with text to provide the human response.",
    },
    "handoff.ack": {
        SupportedLocale.ZH_CN: "已收到你的回复，正在恢复 SOP 执行。回复预览：{reply_preview}",
        SupportedLocale.EN_US: "We received your reply and are resuming SOP execution. Reply preview: {reply_preview}",
    },
    "handoff.command_usage": {
        SupportedLocale.ZH_CN: (
            "用法：/回复反馈 <答复内容>\n"
            "回复内容将作为人工答复并恢复 SOP 执行。\n"
            "也可以直接回复（引用）人工转接通知消息进行答复。"
        ),
        SupportedLocale.EN_US: (
            "Usage: /handoff_reply <response>\n"
            "The response will be used as the human answer and resume SOP execution.\n"
            "You can also reply directly to the quoted human handoff notice."
        ),
    },
    "handoff.identity_missing": {
        SupportedLocale.ZH_CN: "未找到待处理的人工转接请求。或当前渠道账号未绑定到 StaffDeck 处理人身份。",
        SupportedLocale.EN_US: "No pending human handoff request was found, or this channel account is not linked to the assigned StaffDeck user.",
    },
    "handoff.quoted_missing": {
        SupportedLocale.ZH_CN: "未找到该引用消息对应的待处理人工转接请求。",
        SupportedLocale.EN_US: "No pending human handoff request matches the quoted message.",
    },
    "handoff.forbidden": {
        SupportedLocale.ZH_CN: "该人工转接请求不是分配给你的，无法代为回复。",
        SupportedLocale.EN_US: "This human handoff request is assigned to someone else and cannot be answered by you.",
    },
    "handoff.pending_missing": {
        SupportedLocale.ZH_CN: "未找到待处理的人工转接请求。可能已被处理或已过期。",
        SupportedLocale.EN_US: "No pending human handoff request was found. It may already be handled or expired.",
    },
    "handoff.multiple": {
        SupportedLocale.ZH_CN: "你有多个待处理的人工转接请求，请直接回复对应的通知消息以指定要回复的请求。",
        SupportedLocale.EN_US: "You have multiple pending human handoff requests. Reply to the matching notice to choose one.",
    },
    "binding.private_only": {
        SupportedLocale.ZH_CN: "绑定/解绑只能在私聊中进行，群聊不支持该操作。",
        SupportedLocale.EN_US: "Account linking and unlinking are available only in direct messages.",
    },
    "binding.usage": {
        SupportedLocale.ZH_CN: "用法：/绑定 <6位绑定码>。绑定码请在 StaffDeck 网页端生成。",
        SupportedLocale.EN_US: "Usage: /bind <6-digit code>. Generate the code in StaffDeck.",
    },
    "binding.cooldown": {
        SupportedLocale.ZH_CN: "尝试次数过多，请 10 分钟后再试。",
        SupportedLocale.EN_US: "Too many attempts. Try again in 10 minutes.",
    },
    "binding.invalid": {
        SupportedLocale.ZH_CN: "绑定码无效或已过期，请在 StaffDeck 网页端重新生成后再试。",
        SupportedLocale.EN_US: "The linking code is invalid or expired. Generate a new code in StaffDeck and try again.",
    },
    "binding.already_bound": {
        SupportedLocale.ZH_CN: "该{channel_name}账号已绑定到 StaffDeck 账号「{account_name}」，请先发送 /解绑 解除后再绑定。",
        SupportedLocale.EN_US: "This {channel_name} account is already linked to StaffDeck account {account_name}. Send /unbind before linking another account.",
    },
    "binding.success": {
        SupportedLocale.ZH_CN: "绑定成功，{channel_name}对话将与你的 StaffDeck 账号「{account_name}」共享记忆与对话记录。",
        SupportedLocale.EN_US: "Linked successfully. {channel_name} conversations will share memory and history with StaffDeck account {account_name}.",
    },
    "binding.not_bound": {
        SupportedLocale.ZH_CN: "当前{channel_name}账号未绑定 StaffDeck 账号，无需解绑。",
        SupportedLocale.EN_US: "This {channel_name} account is not linked to StaffDeck.",
    },
    "binding.unbound": {
        SupportedLocale.ZH_CN: "已解绑 StaffDeck 账号「{account_name}」，后续对话将使用独立的{channel_name}访客身份。",
        SupportedLocale.EN_US: "Unlinked StaffDeck account {account_name}. Future conversations will use an independent {channel_name} guest identity.",
    },
    "handoff.notice_assigned": {
        SupportedLocale.ZH_CN: "【人工介入转接】已转接给真人员工 {assignee_name}",
        SupportedLocale.EN_US: "[Human handoff] Assigned to {assignee_name}",
    },
    "handoff.notice_unassigned": {
        SupportedLocale.ZH_CN: "【人工介入转接】有一条人工介入待处理",
        SupportedLocale.EN_US: "[Human handoff] A request needs attention",
    },
    "handoff.problem_label": {
        SupportedLocale.ZH_CN: "问题:{problem}",
        SupportedLocale.EN_US: "Issue: {problem}",
    },
    "handoff.context_label": {
        SupportedLocale.ZH_CN: "上下文:",
        SupportedLocale.EN_US: "Context:",
    },
    "handoff.reply_instructions": {
        SupportedLocale.ZH_CN: "如需答复，请直接回复本条消息（引用后输入答复内容）；也可发送 /回复反馈 <答复内容>。",
        SupportedLocale.EN_US: "Reply directly to this message with the response, or send /handoff_reply <response>.",
    },
    "handoff.default_problem": {
        SupportedLocale.ZH_CN: "当前 SOP 需要人工确认后继续执行。",
        SupportedLocale.EN_US: "The current SOP needs human confirmation before it can continue.",
    },
    "handoff.inquirer": {
        SupportedLocale.ZH_CN: "提问人:{inquirer}",
        SupportedLocale.EN_US: "Requester: {inquirer}",
    },
    "handoff.collected_info": {
        SupportedLocale.ZH_CN: "已收集信息:\n{details}",
        SupportedLocale.EN_US: "Collected information:\n{details}",
    },
    "trace.header.running": {
        SupportedLocale.ZH_CN: "正在思考…",
        SupportedLocale.EN_US: "Thinking…",
    },
    "trace.header.completed": {
        SupportedLocale.ZH_CN: "执行完成",
        SupportedLocale.EN_US: "Execution complete",
    },
    "trace.header.failed": {
        SupportedLocale.ZH_CN: "执行失败",
        SupportedLocale.EN_US: "Execution failed",
    },
    "trace.waiting": {
        SupportedLocale.ZH_CN: "等待执行步骤…",
        SupportedLocale.EN_US: "Waiting for execution steps…",
    },
    "trace.intent": {
        SupportedLocale.ZH_CN: "判断意图 {decision}",
        SupportedLocale.EN_US: "Routing request: {decision}",
    },
    "trace.sop.failed": {
        SupportedLocale.ZH_CN: "流程未完成",
        SupportedLocale.EN_US: "SOP did not complete",
    },
    "trace.sop.completed": {
        SupportedLocale.ZH_CN: "流程已结束",
        SupportedLocale.EN_US: "SOP complete",
    },
    "trace.sop.paused": {
        SupportedLocale.ZH_CN: "📖 流程已暂停",
        SupportedLocale.EN_US: "📖 SOP paused",
    },
    "trace.sop.paused_detail": {
        SupportedLocale.ZH_CN: "等待用户补充信息后继续",
        SupportedLocale.EN_US: "Waiting for more information from the user",
    },
    "trace.sop.running": {
        SupportedLocale.ZH_CN: "{icon} 正在推进SOP",
        SupportedLocale.EN_US: "{icon} Advancing SOP",
    },
    "trace.skill.started": {
        SupportedLocale.ZH_CN: "进入流程 {skill_name}",
        SupportedLocale.EN_US: "Started workflow {skill_name}",
    },
    "trace.skill.resumed": {
        SupportedLocale.ZH_CN: "恢复流程 {skill_name}",
        SupportedLocale.EN_US: "Resumed workflow {skill_name}",
    },
    "trace.skill.advanced": {
        SupportedLocale.ZH_CN: "推进流程 {skill_name}",
        SupportedLocale.EN_US: "Advanced workflow {skill_name}",
    },
    "trace.skill.completed": {
        SupportedLocale.ZH_CN: "完成流程 {skill_name}",
        SupportedLocale.EN_US: "Completed workflow {skill_name}",
    },
    "trace.step.current": {
        SupportedLocale.ZH_CN: "当前步骤 {step_name}",
        SupportedLocale.EN_US: "Current step: {step_name}",
    },
    "trace.step.phase": {
        SupportedLocale.ZH_CN: "当前环节 {step_name}",
        SupportedLocale.EN_US: "Current phase: {step_name}",
    },
    "trace.step.handoff": {
        SupportedLocale.ZH_CN: "转人工处理",
        SupportedLocale.EN_US: "Hand off to a person",
    },
    "trace.step.final_reply": {
        SupportedLocale.ZH_CN: "反馈最终结果",
        SupportedLocale.EN_US: "Provide the final result",
    },
    "trace.step.collect": {
        SupportedLocale.ZH_CN: "收集需要的信息",
        SupportedLocale.EN_US: "Collect required information",
    },
    "trace.step.reply": {
        SupportedLocale.ZH_CN: "反馈处理结果",
        SupportedLocale.EN_US: "Provide the result",
    },
    "trace.frame.started": {
        SupportedLocale.ZH_CN: "开始执行任务",
        SupportedLocale.EN_US: "Started task execution",
    },
    "trace.frame.completed": {
        SupportedLocale.ZH_CN: "任务执行完成",
        SupportedLocale.EN_US: "Task completed",
    },
    "trace.frame.awaiting_user": {
        SupportedLocale.ZH_CN: "等待用户补充信息",
        SupportedLocale.EN_US: "Waiting for more information from the user",
    },
    "trace.frame.handoff": {
        SupportedLocale.ZH_CN: "已转人工处理",
        SupportedLocale.EN_US: "Handed off to a person",
    },
    "trace.frame.failed": {
        SupportedLocale.ZH_CN: "任务执行失败",
        SupportedLocale.EN_US: "Task failed",
    },
    "trace.frame.action_count": {
        SupportedLocale.ZH_CN: "共执行 {action_count} 个操作",
        SupportedLocale.EN_US: "Executed {action_count} actions",
    },
    "trace.action.started": {
        SupportedLocale.ZH_CN: "调用能力 {tool_name}",
        SupportedLocale.EN_US: "Calling capability {tool_name}",
    },
    "trace.action.completed": {
        SupportedLocale.ZH_CN: "能力调用完成 {tool_name}",
        SupportedLocale.EN_US: "Capability completed: {tool_name}",
    },
    "trace.action.failed": {
        SupportedLocale.ZH_CN: "能力调用失败 {tool_name}",
        SupportedLocale.EN_US: "Capability failed: {tool_name}",
    },
    "trace.action.finish": {
        SupportedLocale.ZH_CN: "整理任务结果",
        SupportedLocale.EN_US: "Preparing task results",
    },
    "trace.tool.capability_describe": {
        SupportedLocale.ZH_CN: "查看能力详情",
        SupportedLocale.EN_US: "View capability details",
    },
    "trace.skill.reason_completed": {
        SupportedLocale.ZH_CN: "全部步骤已完成",
        SupportedLocale.EN_US: "All steps completed",
    },
}


def _notice_context(value: LanguageContext | dict | None) -> LanguageContext:
    """Resolve a canonical snapshot, using only the explicit legacy zh-CN fallback."""
    return resolve_compatible_language_context(
        snapshot=value,
        legacy_ui_locale=None,
        legacy_agent_reply_locale=None,
    )


def render_channel_notice(
    notice: ChannelNotice,
    language_context: LanguageContext | dict | None,
) -> str:
    """Render channel-owned product chrome from a stable code and immutable reply locale."""
    context = _notice_context(language_context)
    templates = _NOTICE_TEXT.get(notice.code)
    if templates is None:
        raise ValueError(f"unknown channel notice code: {notice.code}")
    template = templates[context.agent_reply_locale]
    expected_params = {
        field_name
        for _, field_name, _, _ in Formatter().parse(template)
        if field_name is not None
    }
    actual_params = set(notice.params)
    if expected_params != actual_params:
        raise ValueError(
            f"channel notice params mismatch: {notice.code} "
            f"expected={sorted(expected_params)} actual={sorted(actual_params)}"
        )
    return template.format_map(notice.params)


def channel_notice_name(channel: str, locale: SupportedLocale) -> str:
    """Return channel product chrome while preserving known provider brand spellings."""
    if locale is SupportedLocale.EN_US:
        return {
            "wechat": "WeChat",
            "wecom": "WeCom",
            "feishu": "Feishu",
            "dingtalk": "DingTalk",
        }.get(channel, channel)
    return channel_label(channel)


def help_text(channel: str, language_context: LanguageContext | dict | None = None) -> str:
    """Render command help from reply locale while keeping channel brands exact."""
    context = _notice_context(language_context)
    return render_channel_notice(
        ChannelNotice(
            code="routing.help",
            params={"channel_name": channel_notice_name(channel, context.agent_reply_locale)},
        ),
        context,
    )


# 兼容仍直接引用常量的微信测试和调用方；运行时回复使用 binding.channel 动态生成。
HELP_TEXT = help_text("wechat")


@dataclass
class ChannelCommand:
    kind: str  # list/current/help/switch/bind/unbind/handoff_reply
    query: str = ""  # switch 的目标名字(可为空)


def parse_command(text: str) -> ChannelCommand | None:
    """解析行首斜杠指令(忽略大小写与首尾空白);非指令消息返回 None。"""
    stripped = (text or "").strip()
    if not stripped.startswith(COMMAND_PREFIX):
        return None
    body = stripped[1:].strip()
    lowered = body.lower()
    if lowered in {"员工", "list"}:
        return ChannelCommand(kind="list")
    if lowered in {"当前", "目前", "current"}:
        return ChannelCommand(kind="current")
    if lowered in {"帮助", "help", "?", "？"}:
        return ChannelCommand(kind="help")
    if lowered in {"解绑", "unbind"}:
        return ChannelCommand(kind="unbind")
    for prefix in ("绑定", "bind"):
        if lowered.startswith(prefix):
            return ChannelCommand(kind="bind", query=body[len(prefix) :].strip())
    for prefix in ("切换", "switch"):
        if lowered.startswith(prefix):
            return ChannelCommand(kind="switch", query=body[len(prefix) :].strip())
    for prefix in ("回复反馈", "handoff_reply"):
        if lowered.startswith(prefix):
            return ChannelCommand(kind="handoff_reply", query=body[len(prefix) :].strip())
    if body and " " not in body and "\n" not in body:
        # /<名字> 直达
        return ChannelCommand(kind="switch", query=body)
    return ChannelCommand(kind="help")


def mounted_agents(db: Session, binding: ChannelBinding) -> list[ChannelBindingAgent]:
    """挂载集;无挂载行(存量 v1 绑定)回退为 [binding.agent_id] 默认,不依赖回填。

    指向已删除员工的孤儿挂载行直接过滤(删除员工会清理挂载,这里兜底历史数据),
    避免 /员工 列表出现裸 agent_id、或 /切换 把会话路由到已删除员工。
    挂载行全部失效时按存量绑定回退。
    """
    rows = db.exec(
        select(ChannelBindingAgent)
        .where(ChannelBindingAgent.binding_id == binding.id)
        .order_by(ChannelBindingAgent.sort_order, ChannelBindingAgent.created_at)
    ).all()
    if rows:
        alive_ids = set(agent_names(db, binding.tenant_id, [row.agent_id for row in rows]))
        mounted = [row for row in rows if row.agent_id in alive_ids]
        if mounted:
            return mounted
    return [
        ChannelBindingAgent(
            tenant_id=binding.tenant_id,
            binding_id=binding.id,
            agent_id=binding.agent_id,
            is_default=True,
            sort_order=0,
        )
    ]


def default_agent_id(mounts: list[ChannelBindingAgent]) -> str:
    for mount in mounts:
        if mount.is_default:
            return mount.agent_id
    return mounts[0].agent_id


def agent_names(db: Session, tenant_id: str, agent_ids: list[str]) -> dict[str, str]:
    if not agent_ids:
        return {}
    rows = db.exec(
        select(AgentProfile).where(
            AgentProfile.tenant_id == tenant_id,
            AgentProfile.id.in_(agent_ids),
        )
    ).all()
    return {row.id: row.name for row in rows}


def _get_conv_state(
    db: Session, binding: ChannelBinding, external_conv_id: str
) -> ChannelConvState | None:
    return db.exec(
        select(ChannelConvState).where(
            ChannelConvState.binding_id == binding.id,
            ChannelConvState.external_conv_id == external_conv_id,
        )
    ).first()


def resolve_current_agent(
    db: Session,
    binding: ChannelBinding,
    external_conv_id: str,
) -> tuple[str, bool]:
    """返回 (当前员工 agent_id, 是否发生了重置需提示)。

    无指针 → 建指针=默认员工;指针员工已不在挂载集 → 重置默认并标记需提示。
    """
    mounts = mounted_agents(db, binding)
    fallback = default_agent_id(mounts)
    state = _get_conv_state(db, binding, external_conv_id)
    if not state:
        db.add(
            ChannelConvState(
                tenant_id=binding.tenant_id,
                binding_id=binding.id,
                external_conv_id=external_conv_id,
                current_agent_id=fallback,
            )
        )
        db.flush()
        return fallback, False
    mounted_ids = {mount.agent_id for mount in mounts}
    if state.current_agent_id not in mounted_ids:
        state.current_agent_id = fallback
        state.updated_at = utc_now()
        db.add(state)
        db.flush()
        return fallback, True
    return state.current_agent_id, False


def set_current_agent(
    db: Session,
    binding: ChannelBinding,
    external_conv_id: str,
    agent_id: str,
    *,
    pin_until=None,
) -> None:
    """写路由指针;pin_until 非空时同时写手动保护窗(智能分发跳过)。"""
    state = _get_conv_state(db, binding, external_conv_id)
    if state:
        state.current_agent_id = agent_id
        state.routing_revision += 1
        state.updated_at = utc_now()
        if pin_until is not None:
            state.manual_pin_until = pin_until
    else:
        state = ChannelConvState(
            tenant_id=binding.tenant_id,
            binding_id=binding.id,
            external_conv_id=external_conv_id,
            current_agent_id=agent_id,
            manual_pin_until=pin_until,
        )
    db.add(state)
    db.flush()


def route_revision(
    db: Session,
    binding: ChannelBinding,
    external_conv_id: str,
) -> tuple[str, int] | None:
    """Return the current route pointer and its compare-and-set revision."""
    state = _get_conv_state(db, binding, external_conv_id)
    if not state:
        return None
    return state.current_agent_id, state.routing_revision


def compare_and_set_current_agent(
    db: Session,
    binding: ChannelBinding,
    external_conv_id: str,
    *,
    expected_agent_id: str,
    expected_revision: int,
    agent_id: str,
) -> bool:
    """Apply an automatic route only while the inspected route is still current."""
    now = utc_now()
    result = db.exec(
        update(ChannelConvState)
        .where(
            ChannelConvState.binding_id == binding.id,
            ChannelConvState.external_conv_id == external_conv_id,
            ChannelConvState.current_agent_id == expected_agent_id,
            ChannelConvState.routing_revision == expected_revision,
            or_(
                ChannelConvState.manual_pin_until.is_(None),
                ChannelConvState.manual_pin_until <= now,
            ),
        )
        .values(
            current_agent_id=agent_id,
            routing_revision=ChannelConvState.routing_revision + 1,
            updated_at=now,
        )
        .execution_options(synchronize_session=False)
    )
    db.flush()
    return result.rowcount == 1


def manual_pin_active(db: Session, binding: ChannelBinding, external_conv_id: str) -> bool:
    """手动切换保护窗是否仍在有效期内。"""
    state = _get_conv_state(db, binding, external_conv_id)
    return bool(state and state.manual_pin_until and state.manual_pin_until > utc_now())


def _display_name(names: dict[str, str], agent_id: str) -> str:
    return names.get(agent_id) or agent_id


def run_command(
    db: Session,
    binding: ChannelBinding,
    external_conv_id: str,
    cmd: ChannelCommand,
    *,
    language_context: LanguageContext | dict | None = None,
) -> str:
    """Execute a slash command and render only its channel-owned chrome."""
    context = _notice_context(language_context)
    mounts = mounted_agents(db, binding)
    names = agent_names(db, binding.tenant_id, [mount.agent_id for mount in mounts])
    current_id, _ = resolve_current_agent(db, binding, external_conv_id)
    if cmd.kind == "list":
        is_english = context.agent_reply_locale is SupportedLocale.EN_US
        lines = ["Available employees:" if is_english else "可调度员工："]
        for index, mount in enumerate(mounts, start=1):
            marks = []
            if mount.is_default:
                marks.append("default" if is_english else "默认")
            if mount.agent_id == current_id:
                marks.append("current" if is_english else "当前")
            suffix = (
                f" ({'/'.join(marks)})"
                if is_english and marks
                else (f"（{'/'.join(marks)}）" if marks else "")
            )
            lines.append(f"{index}. {_display_name(names, mount.agent_id)}{suffix}")
        lines.append(
            "Enter /switch <name> to switch employees or /current to view the current employee."
            if is_english
            else "输入 /切换 <名字> 切换员工，/当前 查看当前员工。"
        )
        return "\n".join(lines)
    if cmd.kind == "current":
        return render_channel_notice(
            ChannelNotice("routing.current", {"agent_name": _display_name(names, current_id)}),
            context,
        )
    if cmd.kind == "switch":
        if not cmd.query:
            return render_channel_notice(ChannelNotice("routing.switch_usage"), context)
        lowered = cmd.query.casefold()
        target = next(
            (
                mount
                for mount in mounts
                if _display_name(names, mount.agent_id).casefold() == lowered
            ),
            None,
        )
        if not target:
            return render_channel_notice(
                ChannelNotice("routing.not_found", {"query": cmd.query}), context
            )
        target_name = _display_name(names, target.agent_id)
        if target.agent_id == current_id:
            return render_channel_notice(
                ChannelNotice("routing.already_current", {"agent_name": target_name}), context
            )
        # 手动切换成功:写 10 分钟保护窗,窗内智能分发不自动切回
        set_current_agent(
            db,
            binding,
            external_conv_id,
            target.agent_id,
            pin_until=utc_now() + timedelta(minutes=10),
        )
        return render_channel_notice(
            ChannelNotice("routing.switched", {"agent_name": target_name}), context
        )
    return help_text(binding.channel, context)
