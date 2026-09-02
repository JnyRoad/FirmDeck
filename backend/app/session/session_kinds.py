"""Define stable machine session kinds without coupling behavior to visible titles."""

from __future__ import annotations

from typing import Literal

from sqlalchemy import and_, or_
from sqlalchemy.sql.elements import ColumnElement

from app.db.models import ChatSession

SESSION_KIND_TEAM_TL = "team_tl"
SESSION_KIND_TEAM_MEMBER_TASK = "team_member_task"
SESSION_KIND_TEAM_SYNTHESIS = "team_synthesis"
SESSION_KIND_TEAM_TL_REVIEW = "team_tl_review"
SESSION_KIND_TEAM_MEMBER_BID = "team_member_bid"
SESSION_KIND_TEAM_BID_SCORE = "team_bid_score"
SESSION_KIND_TEAM_BID_JUDGE = "team_bid_judge"
SESSION_KIND_SCHEDULED_TASK = "scheduled_task"
SESSION_KIND_SKILL_TEST = "skill_test"

TeamConversationKindValue = Literal[
    "tl_chat",
    "member_task",
    "member_bid",
    "tl_review",
]


def _is_legacy_team_tl_title(title: str | None) -> bool:
    """Recognize only the exact product-owned title shape emitted before session kinds existed."""
    normalized = title or ""
    return normalized.startswith("团队 ") and normalized.endswith("TL 对话")


def is_team_tl_session(session: ChatSession) -> bool:
    """Identify human-writable TL sessions from the machine kind or the exact legacy title seam."""
    if session.session_kind is not None:
        return session.session_kind == SESSION_KIND_TEAM_TL
    return bool(session.team_id) and _is_legacy_team_tl_title(session.title)


def team_tl_session_filter() -> ColumnElement[bool]:
    """Build the SQL predicate shared by TL lookup and visibility queries during migration."""
    return or_(
        ChatSession.session_kind == SESSION_KIND_TEAM_TL,
        and_(
            ChatSession.session_kind.is_(None),
            ChatSession.team_id.is_not(None),
            ChatSession.title.like("团队 %TL 对话"),
        ),
    )


def team_conversation_kind(session: ChatSession) -> TeamConversationKindValue:
    """Project stable team session kinds while preserving exact legacy records during rollout."""
    kind = session.session_kind
    if kind == SESSION_KIND_TEAM_MEMBER_TASK:
        return "member_task"
    if kind == SESSION_KIND_TEAM_TL_REVIEW:
        return "tl_review"
    if kind in {
        SESSION_KIND_TEAM_MEMBER_BID,
        SESSION_KIND_TEAM_BID_SCORE,
        SESSION_KIND_TEAM_BID_JUDGE,
    }:
        return "member_bid"
    if kind is not None:
        return "tl_chat"

    title = session.title or ""
    if title.startswith("团队任务验收:"):
        return "tl_review"
    if title.startswith("团队任务:"):
        return "member_task"
    if title.startswith("团队竞标"):
        return "member_bid"
    return "tl_chat"
