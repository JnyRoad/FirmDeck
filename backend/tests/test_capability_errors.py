from app.capabilities.errors import CapabilityErrorInfo, CapabilityProviderError


def test_provider_error_is_classified_without_parsing_message() -> None:
    error = CapabilityProviderError(
        CapabilityErrorInfo(
            code="KNOWLEDGE_UPSTREAM_TIMEOUT",
            message="Knowledge service did not answer before the deadline",
            retryable=True,
            request_id="req-1",
        )
    )

    assert str(error) == "Knowledge service did not answer before the deadline"
    assert error.info.code == "KNOWLEDGE_UPSTREAM_TIMEOUT"
    assert error.info.retryable is True
    assert error.info.to_payload()["error_code"] == "KNOWLEDGE_UPSTREAM_TIMEOUT"


def test_provider_error_exposes_canonical_descriptor_without_raw_message() -> None:
    """Keep provider prose only in the deprecated v1 field while canonical data stays safe."""
    raw_provider_message = "upstream secret body: token=do-not-publish"
    info = CapabilityErrorInfo(
        code="KNOWLEDGE_UPSTREAM_TIMEOUT",
        message=raw_provider_message,
        retryable=True,
        request_id="req-capability",
        trace_id="trace-capability",
        params={"provider_id": "knowledge-primary"},
    )

    descriptor = info.to_descriptor()
    assert descriptor.model_dump(mode="json") == {
        "code": "KNOWLEDGE_UPSTREAM_TIMEOUT",
        "params": {"provider_id": "knowledge-primary"},
        "retryable": True,
        "request_id": "req-capability",
        "trace_id": "trace-capability",
    }
    assert raw_provider_message not in repr(descriptor)
    assert info.to_payload()["deprecated_fields"] == ["message"]
