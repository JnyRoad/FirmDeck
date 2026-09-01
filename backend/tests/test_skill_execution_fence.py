"""RED contracts for skill provider execution fences."""

from __future__ import annotations

import json

from app.db.models import ModelConfig
from app.security.encryption import encrypt_secret
from app.skills import skill_distiller, skill_editor
from app.skills.skill_distiller import SkillDistiller
from app.skills.skill_editor import SkillEditor
from app.skills.skill_schema import SkillCard, SkillDistillRequest, SkillRewriteRequest


def _model_config() -> ModelConfig:
    return ModelConfig(
        tenant_id="tenant_demo",
        name="execution-fence-test",
        api_key_encrypted=encrypt_secret("test-only"),
        model="mock-model",
    )


def _skill_card() -> SkillCard:
    return SkillCard.model_validate(
        {
            "skill_id": "skill_execution_fence",
            "name": "Execution fence",
            "version": "1.0.0",
            "nodes": [
                {
                    "node_id": "finish",
                    "name": "Finish",
                    "instruction": "Return the result.",
                    "allowed_actions": ["answer_user"],
                }
            ],
            "edges": [],
            "start_node_id": "finish",
            "terminal_node_ids": ["finish"],
        }
    )


def _generated_skill_json() -> str:
    return json.dumps({"draft_skill": _skill_card().model_dump(mode="json"), "warnings": []})


def _reflection_pass_json() -> str:
    return json.dumps(
        {
            "passed": True,
            "summary": "ok",
            "rubric_results": [],
            "warnings": [],
            "source_warnings": [],
            "tool_mentions": [],
        }
    )


def test_skill_distiller_fences_main_provider_and_reflection(monkeypatch) -> None:
    calls: list[str] = []

    def fake_generate_text(self, _prompt, payload):
        if payload.get("reflection_round"):
            return _reflection_pass_json()
        return _generated_skill_json()

    monkeypatch.setattr(skill_distiller.LLMClient, "generate_text", fake_generate_text)

    SkillDistiller().distill(
        SkillDistillRequest(
            tenant_id="tenant_demo",
            title="Execution fence",
            raw_content="Return the result.",
        ),
        _model_config(),
        execution_fence=lambda: calls.append("fence"),
    )

    assert len(calls) == 4


def test_skill_editor_fences_main_provider_and_reflection(monkeypatch) -> None:
    calls: list[str] = []

    monkeypatch.setattr(
        skill_editor.LLMClient,
        "generate_json",
        lambda self, _prompt, _payload: {
            "draft_skill": _skill_card().model_dump(mode="json"),
            "assistant_message": "updated",
        },
    )
    monkeypatch.setattr(
        skill_editor.LLMClient,
        "generate_text",
        lambda self, _prompt, payload: _reflection_pass_json()
        if payload.get("reflection_round")
        else _generated_skill_json(),
    )

    SkillEditor().rewrite(
        SkillRewriteRequest(
            tenant_id="tenant_demo",
            current_skill=_skill_card(),
            instruction="Keep the result clear.",
        ),
        _model_config(),
        execution_fence=lambda: calls.append("fence"),
    )

    assert len(calls) == 4
