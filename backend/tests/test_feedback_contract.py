from __future__ import annotations

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.api.feedback import (
    _project_feedback_analysis,
    get_feedback_summary,
    list_feedback_sessions,
)
from app.db.models import ChatSession, Message, MessageFeedback, Tenant, User
from app.feedback.service import feedback_analysis_read, feedback_summary


def test_feedback_analysis_projection_uses_stable_ids_and_preserves_model_content() -> None:
    """Expose stable analysis identifiers while keeping model-authored fields byte-for-byte raw."""
    raw_summary = "RAW model summary / 不要翻译"
    raw_evidence = [
        "RAW evidence / 不要改写",
        {"source": "provider-output", "error": "raw model evidence"},
    ]
    row = MessageFeedback(
        tenant_id="tenant_demo",
        session_id="session_demo",
        message_id="message_demo",
        user_id="user_demo",
        rating="down",
        analysis_status="analyzed",
        analysis_bucket="model_issue",
        analysis_reason="RAW model reason / 不要翻译",
        analysis_summary=raw_summary,
        analysis_json={"evidence": raw_evidence, "bucket_label": "模型问题"},
    )

    result = feedback_analysis_read(row)

    assert result["status"] == "analyzed"
    assert result["status_params"] == {}
    assert result["bucket"] == "model_issue"
    assert result["bucket_params"] == {}
    assert "bucket_label" not in result
    assert result["summary"] == raw_summary
    assert result["metadata"]["evidence"] == raw_evidence
    assert "bucket_label" not in result["metadata"]
    assert result["evidence"] == raw_evidence
    assert _project_feedback_analysis(row)["metadata"]["evidence"] == raw_evidence


def test_feedback_projection_fails_closed_for_unknown_ids_without_localized_fallback() -> None:
    """Collapse malformed persisted identifiers to stable sentinels without publishing labels."""
    row = MessageFeedback(
        tenant_id="tenant_demo",
        session_id="session_demo",
        message_id="message_demo",
        user_id="user_demo",
        rating="down",
        analysis_status="异常状态",
        analysis_bucket="陌生标签",
    )

    result = feedback_analysis_read(row)

    assert result["status"] == "unknown"
    assert result["status_params"] == {}
    assert result["bucket"] == "unknown"
    assert result["bucket_params"] == {}
    assert "bucket_label" not in result
    assert "异常状态" not in repr(result)
    assert "陌生标签" not in repr(result)


def test_feedback_summary_contract_has_typed_params_without_backend_labels() -> None:
    """Return count parameters and raw model summaries instead of localized aggregate prose."""
    raw_summary = "RAW aggregate source"
    rows = [
        MessageFeedback(
            tenant_id="tenant_demo",
            session_id="session_1",
            message_id="msg_1",
            user_id="user_demo",
            rating="down",
            analysis_status="analyzed",
            analysis_bucket="model_issue",
            analysis_summary=raw_summary,
        ),
        MessageFeedback(
            tenant_id="tenant_demo",
            session_id="session_2",
            message_id="msg_2",
            user_id="user_demo",
            rating="down",
            analysis_status="pending",
            analysis_bucket=None,
        ),
    ]

    result = feedback_summary(rows)

    assert result["bucket_counts"] == [
        {"bucket": "model_issue", "count": 1, "params": {"count": 1}},
        {"bucket": "unknown", "count": 1, "params": {"count": 1}},
    ]
    assert result["summary"] == {
        "bucket": "model_issue",
        "params": {"count": 1},
        "detail": raw_summary,
    }
    assert result["top_summaries"][0]["summary"] == raw_summary
    assert "label" not in result["bucket_counts"][0]
    assert "模型问题" not in repr(result)


def test_feedback_summary_api_returns_the_same_identifier_contract() -> None:
    """Ensure the enterprise summary route does not reintroduce server-owned bucket labels."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as db:
        tenant = Tenant(id="tenant_demo", name="Demo")
        user = User(
            id="user_demo",
            tenant_id=tenant.id,
            username="demo",
            display_name="Demo",
            password_hash="hash",
        )
        session = ChatSession(id="session_demo", tenant_id=tenant.id, user_id=user.id)
        db.add_all([tenant, user, session])
        db.add(
            MessageFeedback(
                id="feedback_demo",
                tenant_id=tenant.id,
                session_id=session.id,
                message_id="message_demo",
                user_id=user.id,
                rating="down",
                analysis_status="analyzed",
                analysis_bucket="model_issue",
                analysis_summary="RAW API summary",
            )
        )
        db.commit()

        result = get_feedback_summary(
            tenant_id=tenant.id,
            agent_id=None,
            limit=1000,
            current_user=user,
            db=db,
        )

    assert result["bucket_counts"] == [
        {"bucket": "model_issue", "count": 1, "params": {"count": 1}}
    ]
    assert result["summary"]["bucket"] == "model_issue"
    assert result["summary"]["params"]["count"] == 1
    assert "label" not in result["bucket_counts"][0]
    assert "模型问题" not in repr(result)


def test_feedback_sessions_api_exposes_identifier_params_without_bucket_labels() -> None:
    """Ensure the grouped sessions endpoint shares the canonical analysis projection."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)
    with Session(engine) as db:
        tenant = Tenant(id="tenant_demo", name="Demo")
        user = User(
            id="user_demo",
            tenant_id=tenant.id,
            username="demo",
            display_name="Demo",
            password_hash="hash",
        )
        session = ChatSession(id="session_demo", tenant_id=tenant.id, user_id=user.id)
        message = Message(
            id="message_demo",
            tenant_id=tenant.id,
            session_id=session.id,
            role="assistant",
            content="RAW answer",
        )
        db.add_all([tenant, user, session, message])
        db.add(
            MessageFeedback(
                id="feedback_demo",
                tenant_id=tenant.id,
                session_id=session.id,
                message_id=message.id,
                user_id=user.id,
                rating="down",
                analysis_status="analyzed",
                analysis_bucket="model_issue",
                analysis_summary="RAW session summary",
            )
        )
        db.commit()

        result = list_feedback_sessions(
            tenant_id=tenant.id,
            rating="down",
            agent_id=None,
            limit=200,
            current_user=user,
            db=db,
        )

    assert len(result) == 1
    row = result[0]
    assert row["analysis_status"] == "analyzed"
    assert row["analysis_status_params"] == {}
    assert row["analysis_bucket"] == "model_issue"
    assert row["analysis_bucket_params"] == {}
    assert row["primary_bucket"] == "model_issue"
    assert "analysis_bucket_label" not in row
    assert "primary_bucket_label" not in row
    assert "模型问题" not in repr(row)
