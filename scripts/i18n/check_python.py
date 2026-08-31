"""AST governance for backend product errors, responses, events, and exception leakage."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
PUBLIC_TEXT_FIELDS = {
    "detail",
    "error",
    "message",
    "reply_fragment",
    "status_text",
    "text",
}
HTTP_EXCEPTION_NAMES = {"HTTPException"}
RESPONSE_NAMES = {"JSONResponse", "ORJSONResponse", "Response"}
PROBLEM_RESPONSE_NAMES = {"problem_response"}
ERROR_CONSTRUCTOR_NAMES = {
    "ErrorDescriptor",
    "KnowledgeError",
    "PublicAPIError",
    "ToolError",
    "build_http_exception",
    "domain_http_error",
}
PUBLIC_ERROR_WRAPPER_NAMES = {"_failure", "_public_harness_error"}
AGENT_REPLY_SINK_NAMES = {"AgentReply", "ChatTurnResponse"}
TASK_RESULT_SINK_NAMES = {"TaskExecutionResult"}
FINAL_REPLY_HELPER_NAMES = {"format_runtime_failure_reply", "tool_failure_reply"}
RAW_DIAGNOSTIC_FIELDS = {
    "diagnostic",
    "error",
    "error_details",
    "error_json",
    "error_traceback",
    "failure_reason",
    "last_error",
    "traceback",
}
PUBLIC_RELAY_NAMES = {
    "AgentEvent",
    "_emit_terminal_job_event",
    "_record_scheduled_task_stream_event",
    "_terminalize_job",
    "_update_ingest_stage",
    "emit_job_event",
    "emit_span_event",
    "record_task_event",
    "stage_webhook_deliveries",
}


@dataclass(frozen=True, slots=True)
class _ErrorWrapperSpec:
    """Describe how one local adapter forwards code and params to a checked constructor."""

    code_parameter: str
    code_position: int | None
    params_parameter: str | None
    params_position: int | None


@dataclass(frozen=True, slots=True)
class _NaturalDetailWrapperSpec:
    """Describe a helper that forwards caller-owned code and message into HTTP detail."""

    code_parameter: str
    code_position: int | None
    message_parameter: str
    message_position: int | None


@dataclass(frozen=True, slots=True)
class PythonI18nDiagnostic:
    """One deterministic backend governance finding suitable for CI serialization."""

    rule: str
    file: str
    line: int
    message: str
    source: str
    code: str | None = None
    severity: str = "error"


def _stable_file(path: Path) -> str:
    """Return a repository-relative path when available so fingerprints survive worktrees."""
    try:
        return path.resolve().relative_to(REPOSITORY_ROOT).as_posix()
    except ValueError:
        return str(path.resolve())


def _call_name(node: ast.Call) -> str:
    """Return a dotted call target without evaluating descriptors or importing application code."""
    parts: list[str] = []
    current: ast.expr = node.func
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        parts.append(current.id)
    return ".".join(reversed(parts))


def _literal_string(node: ast.AST | None) -> str | None:
    """Return only a direct string literal; formatted or computed values remain non-literal."""
    return (
        node.value
        if isinstance(node, ast.Constant) and isinstance(node.value, str)
        else None
    )


def _call_argument(
    node: ast.Call, parameter: str, position: int | None
) -> ast.AST | None:
    """Read one call argument by keyword or positional slot without evaluating the call."""
    keyword_value = next(
        (keyword.value for keyword in node.keywords if keyword.arg == parameter),
        None,
    )
    if keyword_value is not None:
        return keyword_value
    if position is not None and len(node.args) > position:
        return node.args[position]
    return None


def _function_parameter_position(
    node: ast.FunctionDef | ast.AsyncFunctionDef,
    parameter: str,
) -> int | None:
    """Return the positional slot for one function parameter, or None for keyword-only values."""
    positional = [*node.args.posonlyargs, *node.args.args]
    position = next(
        (
            index
            for index, argument in enumerate(positional)
            if argument.arg == parameter
        ),
        None,
    )
    if (
        position is not None
        and positional
        and positional[0].arg in {"cls", "self"}
        and position > 0
    ):
        return position - 1
    return position


def _stream_status_text_position(tree: ast.AST) -> int | None:
    """Resolve the legacy text slot only from this file's exact stream helper definition."""
    definitions = [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
        and node.name == "_add_stream_status_event"
    ]
    if len(definitions) != 1:
        return None
    return _function_parameter_position(definitions[0], "text")


def _call_code_argument(node: ast.Call, short_name: str) -> ast.AST | None:
    """Locate the code argument for a built-in checked error constructor."""
    position = 1 if short_name == "PublicAPIError" else 0
    return _call_argument(node, "code", position)


def _call_params_argument(
    node: ast.Call, short_name: str | None = None
) -> ast.AST | None:
    """Locate the canonical params argument shared by checked error constructors."""
    parameter = (
        "details"
        if short_name in {"HarnessExecutionError", "KnowledgeError"}
        else "params"
    )
    return _call_argument(node, parameter, None)


def _attribute_parts(node: ast.Attribute) -> list[str]:
    """Return stable name/attribute components for one attribute expression."""
    parts = [node.attr]
    current: ast.expr = node.value
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        parts.append(current.id)
    return list(reversed(parts))


def _find_raw_diagnostic_reference(node: ast.AST | None) -> ast.AST | None:
    """Find explicit failure-shaped attributes or nested fields without guessing generic prose."""
    if node is None:
        return None
    for child in ast.walk(node):
        if isinstance(child, ast.Attribute):
            parts = _attribute_parts(child)
            if child.attr in RAW_DIAGNOSTIC_FIELDS or (
                child.attr == "message"
                and any("error" in part.lower() for part in parts[:-1])
            ):
                return child
        if isinstance(child, ast.Dict):
            for field, value in _dict_items(child).items():
                if field == "codexEvent" and not isinstance(value, ast.Call):
                    return value
    return None


def _contains_cjk(value: str) -> bool:
    """Return whether a fixed string contains Chinese-language characters."""
    return any("\u3400" <= char <= "\u9fff" for char in value)


def _except_type_names(node: ast.ExceptHandler) -> set[str]:
    """Return simple handled exception type names for bounded control-flow exclusions."""
    if node.type is None:
        return set()
    return {
        child.id for child in ast.walk(node.type) if isinstance(child, ast.Name)
    } | {
        child.attr for child in ast.walk(node.type) if isinstance(child, ast.Attribute)
    }


def _guarded_registry_names(tree: ast.AST) -> set[str]:
    """Collect locals assigned from an explicit registry lookup or safe fallback expression."""
    guarded: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        calls = [child for child in ast.walk(node.value) if isinstance(child, ast.Call)]
        if not any(
            _call_name(call).endswith((".get", ".require"))
            and "REGISTRY" in _call_name(call).upper()
            for call in calls
        ):
            continue
        guarded.update(
            target.id for target in node.targets if isinstance(target, ast.Name)
        )
    return guarded


def _is_registry_guarded_code(node: ast.AST | None, guarded_names: set[str]) -> bool:
    """Accept only ``entry.code`` expressions whose entry came from an explicit registry lookup."""
    return (
        isinstance(node, ast.Attribute)
        and node.attr == "code"
        and isinstance(node.value, ast.Name)
        and node.value.id in guarded_names
    )


def _is_registry_guarded_public_field(
    node: ast.AST | None, guarded_names: set[str]
) -> bool:
    """Accept only registered entry code/message-key fields at a compatibility sink."""
    return (
        isinstance(node, ast.Attribute)
        and node.attr in {"code", "message_key"}
        and isinstance(node.value, ast.Name)
        and node.value.id in guarded_names
    )


def _module_literal_strings(tree: ast.AST) -> dict[str, str]:
    """Collect module-level string constants so stable code aliases remain statically verifiable."""
    literals: dict[str, str] = {}
    body = tree.body if isinstance(tree, ast.Module) else []
    for node in body:
        if not isinstance(node, ast.Assign):
            continue
        value = _literal_string(node.value)
        if value is None:
            continue
        for target in node.targets:
            if isinstance(target, ast.Name):
                literals[target.id] = value
    return literals


def _path_module_names(path: Path) -> set[str]:
    """Return importable module names for one checked path without importing application code."""
    resolved = path.resolve()
    names = {resolved.stem}
    for base in (REPOSITORY_ROOT, REPOSITORY_ROOT / "backend"):
        try:
            relative = resolved.relative_to(base.resolve()).with_suffix("")
        except ValueError:
            continue
        names.add(".".join(relative.parts))
    return names


def _literal_strings_by_file(
    trees: Mapping[Path, ast.AST],
) -> dict[Path, dict[str, str]]:
    """Resolve local literals and explicit imports from checked modules, never same-name globals."""
    definitions: dict[tuple[str, str], set[str]] = {}
    local_literals = {
        path: _module_literal_strings(tree) for path, tree in trees.items()
    }
    for path, literals in local_literals.items():
        for module_name in _path_module_names(path):
            for name, value in literals.items():
                definitions.setdefault((module_name, name), set()).add(value)

    resolved_by_file: dict[Path, dict[str, str]] = {}
    for path, tree in trees.items():
        resolved = dict(local_literals[path])
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom) or node.module is None:
                continue
            for imported in node.names:
                values = definitions.get((node.module, imported.name), set())
                if len(values) == 1:
                    resolved[imported.asname or imported.name] = next(iter(values))
        resolved_by_file[path] = resolved
    return resolved_by_file


def _guarded_code_names_by_function(tree: ast.AST) -> dict[int, set[str]]:
    """Find dynamic code locals rejected by an explicit registry lookup before public use."""
    guarded: dict[int, set[str]] = {}
    for function in (
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
    ):
        lookup_sources: dict[str, str] = {}
        for assignment in (
            node for node in ast.walk(function) if isinstance(node, ast.Assign)
        ):
            if not isinstance(assignment.value, ast.Call):
                continue
            if not (
                _call_name(assignment.value).endswith(".get")
                and "REGISTRY" in _call_name(assignment.value).upper()
                and assignment.value.args
                and isinstance(assignment.value.args[0], ast.Name)
            ):
                continue
            for target in assignment.targets:
                if isinstance(target, ast.Name):
                    lookup_sources[target.id] = assignment.value.args[0].id
        for conditional in (
            node for node in ast.walk(function) if isinstance(node, ast.If)
        ):
            rejected = any(
                isinstance(child, ast.Return | ast.Raise)
                for statement in conditional.body
                for child in ast.walk(statement)
            )
            for entry_name, code_name in lookup_sources.items():
                guarded_assignment = all(
                    any(
                        isinstance(child, ast.Assign)
                        and any(
                            isinstance(target, ast.Name) and target.id == code_name
                            for target in child.targets
                        )
                        for statement in branch
                        for child in ast.walk(statement)
                    )
                    for branch in (conditional.body, conditional.orelse)
                )
                if _references_names(conditional.test, {entry_name}) and (
                    rejected or guarded_assignment
                ):
                    guarded.setdefault(id(function), set()).add(code_name)
        descriptor_sources: dict[str, str] = {}
        for assignment in (
            node for node in ast.walk(function) if isinstance(node, ast.Assign)
        ):
            if not isinstance(assignment.value, ast.Call):
                continue
            if _call_name(assignment.value).rsplit(".", 1)[-1] != "ErrorDescriptor":
                continue
            code_node = _call_code_argument(assignment.value, "ErrorDescriptor")
            if not isinstance(code_node, ast.Name):
                continue
            for target in assignment.targets:
                if isinstance(target, ast.Name):
                    descriptor_sources[target.id] = code_node.id
        for call in (node for node in ast.walk(function) if isinstance(node, ast.Call)):
            if _call_name(call).rsplit(".", 1)[-1] not in {
                "project_public_error",
                "project_public_error_payload",
            }:
                continue
            for descriptor_name, code_name in descriptor_sources.items():
                if _references_names(call, {descriptor_name}):
                    guarded.setdefault(id(function), set()).add(code_name)
    return guarded


def _dict_items(node: ast.AST | None) -> dict[str, ast.AST]:
    """Return direct string-keyed items from one dict literal without evaluating expressions."""
    if not isinstance(node, ast.Dict):
        return {}
    return {
        key.value: value
        for key, value in zip(node.keys, node.values, strict=True)
        if isinstance(key, ast.Constant) and isinstance(key.value, str)
    }


def _references_names(node: ast.AST | None, names: set[str]) -> bool:
    """Return whether an expression reads any explicitly tracked local name."""
    if node is None or not names:
        return False
    return any(
        isinstance(child, ast.Name)
        and isinstance(child.ctx, ast.Load)
        and child.id in names
        for child in ast.walk(node)
    )


def _find_exception_serialization(
    node: ast.AST | None,
    exception_aliases: set[str],
) -> ast.AST | None:
    """Find the outermost str/repr or formatting expression that reads a caught exception."""
    if node is None:
        return None
    for child in ast.walk(node):
        if isinstance(child, ast.Call) and _call_name(child) == "traceback.format_exc":
            return child
        if (
            isinstance(child, ast.Call)
            and isinstance(child.func, ast.Name)
            and child.func.id in {"repr", "str"}
            and bool(child.args)
            and _references_names(child.args[0], exception_aliases)
        ):
            return child
        if isinstance(child, ast.JoinedStr) and _references_names(
            child, exception_aliases
        ):
            return child
        if (
            isinstance(child, ast.Call)
            and isinstance(child.func, ast.Attribute)
            and child.func.attr == "format"
            and any(
                _references_names(argument, exception_aliases)
                for argument in [
                    *child.args,
                    *(keyword.value for keyword in child.keywords),
                ]
            )
        ):
            return child
        if (
            isinstance(child, ast.BinOp)
            and isinstance(child.op, ast.Mod)
            and _references_names(child.right, exception_aliases)
        ):
            return child
    return None


def _find_result_exception_serialization(
    node: ast.AST | None,
    exception_aliases: set[str],
) -> ast.AST | None:
    """Find exception prose only when it contributes to the expression result, not a predicate."""
    if isinstance(node, ast.Compare):
        return None
    if isinstance(node, ast.IfExp):
        return _find_result_exception_serialization(
            node.body, exception_aliases
        ) or _find_result_exception_serialization(node.orelse, exception_aliases)
    return _find_exception_serialization(node, exception_aliases)


def _subscript_key(node: ast.Subscript) -> str | None:
    """Return a direct string key from one subscript target across supported Python ASTs."""
    return _literal_string(node.slice)


def _subscript_root_name(node: ast.Subscript) -> str | None:
    """Return the local root of a subscript expression without trusting arbitrary mappings."""
    current: ast.expr = node.value
    while isinstance(current, (ast.Attribute, ast.Subscript)):
        current = current.value
    return current.id if isinstance(current, ast.Name) else None


def _attribute_root_name(node: ast.Attribute) -> str | None:
    """Return the leftmost local name for an attribute chain without evaluating descriptors."""
    current: ast.expr = node.value
    while isinstance(current, ast.Attribute):
        current = current.value
    return current.id if isinstance(current, ast.Name) else None


def _find_name_reference(node: ast.AST | None, names: set[str]) -> ast.Name | None:
    """Find the first stable AST name that carries tracked private data into a boundary."""
    if node is None or not names:
        return None
    return next(
        (
            child
            for child in ast.walk(node)
            if isinstance(child, ast.Name)
            and isinstance(child.ctx, ast.Load)
            and child.id in names
        ),
        None,
    )


def _function_arguments(node: ast.FunctionDef | ast.AsyncFunctionDef) -> set[str]:
    """Return every named parameter accepted by one function, including keyword-only values."""
    return {
        argument.arg
        for argument in [
            *node.args.posonlyargs,
            *node.args.args,
            *node.args.kwonlyargs,
        ]
    }


def _forwarded_parameter(node: ast.AST | None, arguments: set[str]) -> str | None:
    """Resolve an expression that forwards exactly one function parameter through safe defaults."""
    if node is None:
        return None
    referenced = {
        child.id
        for child in ast.walk(node)
        if isinstance(child, ast.Name)
        and isinstance(child.ctx, ast.Load)
        and child.id in arguments
    }
    return next(iter(referenced)) if len(referenced) == 1 else None


def _collect_error_wrappers(
    trees: Mapping[Path, ast.AST],
) -> tuple[dict[str, _ErrorWrapperSpec], set[int]]:
    """Discover local adapters that forward a parameter into a checked error constructor."""
    wrappers: dict[str, _ErrorWrapperSpec] = {}
    forwarding_calls: set[int] = set()
    changed = True
    while changed:
        changed = False
        checked_names = ERROR_CONSTRUCTOR_NAMES | set(wrappers)
        for tree in trees.values():
            for function in (
                node
                for node in ast.walk(tree)
                if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
            ):
                if function.name in wrappers or function.name.startswith("__"):
                    continue
                if not any(
                    token in function.name.lower()
                    for token in ("descriptor", "error", "exception")
                ):
                    continue
                if "event" in function.name.lower():
                    continue
                arguments = _function_arguments(function)
                for call in (
                    node for node in ast.walk(function) if isinstance(node, ast.Call)
                ):
                    short_name = _call_name(call).rsplit(".", 1)[-1]
                    if short_name not in checked_names:
                        continue
                    if short_name in wrappers:
                        target = wrappers[short_name]
                        code_node = _call_argument(
                            call,
                            target.code_parameter,
                            target.code_position,
                        )
                        params_node = (
                            _call_argument(
                                call,
                                target.params_parameter,
                                target.params_position,
                            )
                            if target.params_parameter
                            else None
                        )
                    else:
                        code_node = _call_code_argument(call, short_name)
                        params_node = _call_params_argument(call, short_name)
                    if (
                        not isinstance(code_node, ast.Name)
                        or code_node.id not in arguments
                    ):
                        continue
                    params_parameter = _forwarded_parameter(params_node, arguments)
                    wrappers[function.name] = _ErrorWrapperSpec(
                        code_parameter=code_node.id,
                        code_position=_function_parameter_position(
                            function, code_node.id
                        ),
                        params_parameter=params_parameter,
                        params_position=(
                            _function_parameter_position(function, params_parameter)
                            if params_parameter
                            else None
                        ),
                    )
                    forwarding_calls.add(id(call))
                    changed = True
                    break
    return wrappers, forwarding_calls


def _collect_natural_detail_wrappers(
    trees: Mapping[Path, ast.AST],
) -> dict[str, _NaturalDetailWrapperSpec]:
    """Discover helpers that forward parameterized code and message fields into HTTP detail."""
    wrappers: dict[str, _NaturalDetailWrapperSpec] = {}
    for tree in trees.values():
        for function in (
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
        ):
            arguments = _function_arguments(function)
            for call in (
                node for node in ast.walk(function) if isinstance(node, ast.Call)
            ):
                if _call_name(call).rsplit(".", 1)[-1] not in HTTP_EXCEPTION_NAMES:
                    continue
                detail = _call_argument(call, "detail", None)
                items = _dict_items(detail)
                code_node = items.get("code")
                message_node = items.get("message")
                if not (
                    isinstance(code_node, ast.Name)
                    and code_node.id in arguments
                    and isinstance(message_node, ast.Name)
                    and message_node.id in arguments
                ):
                    continue
                wrappers[function.name] = _NaturalDetailWrapperSpec(
                    code_parameter=code_node.id,
                    code_position=_function_parameter_position(function, code_node.id),
                    message_parameter=message_node.id,
                    message_position=_function_parameter_position(
                        function, message_node.id
                    ),
                )
                break
    return wrappers


def _collect_public_error_projectors(
    trees: Mapping[Path, ast.AST],
) -> tuple[dict[Path, set[str]], dict[Path, set[str]]]:
    """Summarize structurally safe canonical projectors and raw-error forwarding helpers."""
    safe_by_path: dict[Path, set[str]] = {}
    unsafe_by_path: dict[Path, set[str]] = {}
    for path, tree in trees.items():
        functions = {
            node.name: node
            for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
        }
        # Workflow: seed each file only from exact canonical imports, then prove local wrappers
        # by fixed point so same-name functions in another module cannot inherit trust.
        safe = {
            imported.asname or imported.name
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom)
            and node.module == "app.contracts.projections"
            for imported in node.names
            if imported.name in {"project_public_error", "project_public_error_payload"}
            and (imported.asname or imported.name) not in functions
        }
        changed = True
        while changed:
            changed = False
            for name, function in functions.items():
                returns = [
                    node
                    for node in ast.walk(function)
                    if isinstance(node, ast.Return) and node.value is not None
                ]
                if not returns or name in safe:
                    continue
                canonical_returns = [
                    return_node
                    for return_node in returns
                    if isinstance(return_node.value, ast.Call)
                    and _call_name(return_node.value).rsplit(".", 1)[-1] in safe
                ]
                passthrough_returns = [
                    return_node
                    for return_node in returns
                    if isinstance(return_node.value, ast.Name)
                    and any(
                        isinstance(statement, ast.If)
                        and _references_names(statement.test, {return_node.value.id})
                        and any(child is return_node for child in ast.walk(statement))
                        for statement in function.body
                    )
                ]
                if canonical_returns and len(canonical_returns) + len(
                    passthrough_returns
                ) == len(returns):
                    safe.add(name)
                    changed = True
        unsafe = {
            name
            for name, function in functions.items()
            if name not in safe
            and "project" in name.lower()
            and "error" in name.lower()
            and any(
                _find_raw_diagnostic_reference(return_node.value) is not None
                for return_node in ast.walk(function)
                if isinstance(return_node, ast.Return) and return_node.value is not None
            )
        }
        safe_by_path[path] = safe
        unsafe_by_path[path] = unsafe
    return safe_by_path, unsafe_by_path


def _validated_error_types(trees: Mapping[Path, ast.AST]) -> set[str]:
    """Find error models whose descriptor method proves registry validation and fallback."""
    validated: set[str] = set()
    for tree in trees.values():
        for class_node in (
            node for node in ast.walk(tree) if isinstance(node, ast.ClassDef)
        ):
            descriptor_method = next(
                (
                    child
                    for child in class_node.body
                    if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef)
                    and child.name == "to_descriptor"
                ),
                None,
            )
            if descriptor_method is None:
                continue
            call_names = {
                _call_name(call)
                for call in ast.walk(descriptor_method)
                if isinstance(call, ast.Call)
            }
            if any(
                name.endswith("ERROR_REGISTRY.validate") for name in call_names
            ) and any(name.endswith("ERROR_REGISTRY.require") for name in call_names):
                validated.add(class_node.name)
    return validated


def _validated_error_wrappers_by_path(
    trees: Mapping[Path, ast.AST], validated_types: set[str]
) -> dict[Path, set[str]]:
    """Find local helpers whose returned typed error is guaranteed to validate on serialization."""
    wrappers: dict[Path, set[str]] = {}
    for path, tree in trees.items():
        wrappers[path] = {
            function.name
            for function in ast.walk(tree)
            if isinstance(function, ast.FunctionDef | ast.AsyncFunctionDef)
            and any(
                isinstance(return_node, ast.Return)
                and return_node.value is not None
                and any(
                    isinstance(call, ast.Call)
                    and _call_name(call).rsplit(".", 1)[-1] in validated_types
                    for call in ast.walk(return_node.value)
                )
                for return_node in ast.walk(function)
            )
        }
    definitions = {
        (module_name, wrapper_name)
        for path, wrapper_names in wrappers.items()
        for module_name in _path_module_names(path)
        for wrapper_name in wrapper_names
    }
    for path, tree in trees.items():
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom) or node.module is None:
                continue
            for imported in node.names:
                if (node.module, imported.name) in definitions:
                    wrappers[path].add(imported.asname or imported.name)
    return wrappers


def _validated_failure_wrappers_by_path(
    trees: Mapping[Path, ast.AST],
) -> dict[Path, set[str]]:
    """Find exact Harness failure sinks that validate registry data before projection."""
    wrappers: dict[Path, set[str]] = {}
    for path, tree in trees.items():
        names: set[str] = set()
        module_literals = set(_module_literal_strings(tree).values())
        for function in (
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
        ):
            if function.name != "_failure":
                continue
            call_names = {
                _call_name(call)
                for call in ast.walk(function)
                if isinstance(call, ast.Call)
            }
            literals = {
                child.value
                for child in ast.walk(function)
                if isinstance(child, ast.Constant) and isinstance(child.value, str)
            }
            literals.update(module_literals)
            if (
                any(name.endswith("ERROR_REGISTRY.require") for name in call_names)
                and any(name.endswith("ERROR_REGISTRY.validate") for name in call_names)
                and "INTERNAL_ERROR" in literals
            ):
                names.add(function.name)
        wrappers[path] = names
    return wrappers


def _fingerprint(diagnostic: PythonI18nDiagnostic) -> str:
    """Hash the exact rule, file, and source expression for a compatibility ratchet entry."""
    evidence = f"{diagnostic.rule}\0{diagnostic.file}\0{diagnostic.source}"
    return f"sha256:{hashlib.sha256(evidence.encode()).hexdigest()}"


def _is_allowlisted(
    diagnostic: PythonI18nDiagnostic,
    entries: Sequence[dict[str, object]],
    today: date,
) -> bool:
    """Suppress only an exact, owned, reasoned, unexpired fingerprint."""
    fingerprint = _fingerprint(diagnostic)
    for entry in entries:
        if (
            entry.get("file") == diagnostic.file
            and entry.get("rule") == diagnostic.rule
            and entry.get("fingerprint") == fingerprint
            and isinstance(entry.get("owner"), str)
            and bool(str(entry["owner"]).strip())
            and isinstance(entry.get("reason"), str)
            and bool(str(entry["reason"]).strip())
            and isinstance(entry.get("expires"), str)
        ):
            try:
                return date.fromisoformat(str(entry["expires"])) >= today
            except ValueError:
                continue
    return False


class _ExceptionPersistenceCollector(ast.NodeVisitor):
    """Collect attribute stores that persist serialization of the current exception alias."""

    def __init__(self) -> None:
        """Initialize lexical exception tracking and the persisted attribute result."""
        self._exception_alias_stack: list[set[str]] = []
        self.attribute_paths: set[tuple[str, str]] = set()

    def _exception_aliases(self) -> set[str]:
        """Return the exception aliases active at the current lexical node."""
        return (
            set().union(*self._exception_alias_stack)
            if self._exception_alias_stack
            else set()
        )

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        """Limit raw-exception recognition to the body of its matching except handler."""
        self._exception_alias_stack.append({node.name} if node.name else set())
        for statement in node.body:
            self.visit(statement)
        self._exception_alias_stack.pop()

    def visit_Assign(self, node: ast.Assign) -> None:
        """Record attribute stores whose value serializes the active exception alias."""
        serialization = _find_result_exception_serialization(
            node.value, self._exception_aliases()
        )
        if serialization is not None:
            for target in node.targets:
                if not isinstance(target, ast.Attribute):
                    continue
                root_name = _attribute_root_name(target)
                if root_name is not None:
                    self.attribute_paths.add((root_name, target.attr))
        self.generic_visit(node)


class _BoundaryVisitor(ast.NodeVisitor):
    """Inspect only known product boundaries, leaving prompts, logs, and raw locals untouched."""

    def __init__(
        self,
        path: Path,
        source: str,
        registered_codes: set[str],
        registered_error_params: Mapping[str, set[str]],
        persisted_exception_attributes: set[tuple[str, str]],
        error_wrappers: Mapping[str, _ErrorWrapperSpec],
        natural_detail_wrappers: Mapping[str, _NaturalDetailWrapperSpec],
        forwarding_calls: set[int],
        guarded_registry_names: set[str],
        guarded_code_names: Mapping[int, set[str]],
        literal_string_names: Mapping[str, str],
        safe_error_projectors: set[str],
        unsafe_error_projectors: set[str],
        validated_error_types: set[str],
        validated_error_wrappers: set[str],
        validated_failure_wrappers: set[str],
        stream_status_text_position: int | None,
    ) -> None:
        """Bind one parsed source and the current registry without executing repository code."""
        self.path = path
        self.source = source
        self.registered_codes = registered_codes
        self.registered_error_params = registered_error_params
        self.persisted_exception_attributes = persisted_exception_attributes
        self.persisted_exception_attribute_names = {
            attribute for _, attribute in persisted_exception_attributes
        }
        self.error_wrappers = error_wrappers
        self.natural_detail_wrappers = natural_detail_wrappers
        self.forwarding_calls = forwarding_calls
        self.guarded_registry_names = guarded_registry_names
        self.guarded_code_names = guarded_code_names
        self.literal_string_names = literal_string_names
        self.safe_error_projectors = safe_error_projectors
        self.unsafe_error_projectors = unsafe_error_projectors
        self.validated_error_types = validated_error_types
        self.validated_error_wrappers = validated_error_wrappers
        self.validated_failure_wrappers = validated_failure_wrappers
        self.stream_status_text_position = stream_status_text_position
        self.diagnostics: list[PythonI18nDiagnostic] = []
        self._route_depth = 0
        self._exception_alias_stack: list[set[str]] = []
        self._local_taint_stack: list[set[str]] = []
        self._fixed_text_local_stack: list[dict[str, ast.AST]] = []
        self._canonical_local_stack: list[set[str]] = []
        self._guarded_code_stack: list[set[str]] = []
        self._function_name_stack: list[str] = []

    def _exception_aliases(self) -> set[str]:
        """Return the exception aliases active at the current lexical node."""
        return (
            set().union(*self._exception_alias_stack)
            if self._exception_alias_stack
            else set()
        )

    def _tainted_locals(self) -> set[str]:
        """Return persisted-exception locals for the innermost function scope."""
        return self._local_taint_stack[-1] if self._local_taint_stack else set()

    def _fixed_text_locals(self) -> dict[str, ast.AST]:
        """Return developer-owned fixed text sources for the innermost function scope."""
        return self._fixed_text_local_stack[-1] if self._fixed_text_local_stack else {}

    def _canonical_locals(self) -> set[str]:
        """Return locals assigned from a proven canonical error projector."""
        return self._canonical_local_stack[-1] if self._canonical_local_stack else set()

    def _resolved_literal_string(self, node: ast.AST | None) -> str | None:
        """Resolve a direct string or a module-level constant without evaluating Python code."""
        direct = _literal_string(node)
        if direct is not None:
            return direct
        return (
            self.literal_string_names.get(node.id)
            if isinstance(node, ast.Name)
            else None
        )

    def _is_guarded_dynamic_code(self, node: ast.AST | None) -> bool:
        """Accept entry.code or a local proven to fail closed after a registry lookup."""
        if _is_registry_guarded_code(node, self.guarded_registry_names):
            return True
        return (
            isinstance(node, ast.Name)
            and bool(self._guarded_code_stack)
            and node.id in self._guarded_code_stack[-1]
        )

    def _references_persisted_exception(self, node: ast.AST | None) -> bool:
        """Return whether an expression reads a persisted exception field or tainted local."""
        if node is None:
            return False
        if _references_names(node, self._tainted_locals()):
            return True
        return any(
            isinstance(child, ast.Attribute)
            and (
                (_attribute_root_name(child), child.attr)
                in self.persisted_exception_attributes
                or child.attr in self.persisted_exception_attribute_names
            )
            for child in ast.walk(node)
        )

    def _tainted_evidence(self, node: ast.AST | None) -> ast.AST | None:
        """Return one stable local or persisted-field reference carrying exception prose."""
        if node is None:
            return None
        if isinstance(node, ast.Call) and (
            _call_name(node).rsplit(".", 1)[-1] in self.safe_error_projectors
        ):
            return None
        local = _find_name_reference(node, self._tainted_locals())
        if local is not None:
            return local
        evidence = next(
            (
                child
                for child in ast.walk(node)
                if isinstance(child, ast.Attribute)
                and (
                    (_attribute_root_name(child), child.attr)
                    in self.persisted_exception_attributes
                    or child.attr in self.persisted_exception_attribute_names
                )
            ),
            None,
        )
        if evidence is None:
            return None
        for safe_call in (
            child
            for child in ast.walk(node)
            if isinstance(child, ast.Call)
            and _call_name(child).rsplit(".", 1)[-1] in self.safe_error_projectors
        ):
            if evidence in ast.walk(safe_call):
                return None
        return evidence

    def _unsafe_projector_evidence(self, node: ast.AST | None) -> ast.Call | None:
        """Return a call whose checked helper summary forwards raw diagnostic fields."""
        if node is None:
            return None
        return next(
            (
                child
                for child in ast.walk(node)
                if isinstance(child, ast.Call)
                and _call_name(child).rsplit(".", 1)[-1] in self.unsafe_error_projectors
            ),
            None,
        )

    def _raw_diagnostic_evidence(self, node: ast.AST | None) -> ast.AST | None:
        """Find raw diagnostic fields while treating only proven local projector calls as opaque."""
        if node is None:
            return None
        if isinstance(node, ast.Call) and (
            _call_name(node).rsplit(".", 1)[-1] in self.safe_error_projectors
        ):
            return None
        direct = _find_raw_diagnostic_reference(node)
        if direct is None:
            return None
        for safe_call in (
            child
            for child in ast.walk(node)
            if isinstance(child, ast.Call)
            and _call_name(child).rsplit(".", 1)[-1] in self.safe_error_projectors
        ):
            if direct in ast.walk(safe_call):
                return None
        return direct

    def _report(
        self,
        rule: str,
        node: ast.AST,
        message: str,
        *,
        code: str | None = None,
    ) -> None:
        """Append one bounded finding with exact AST evidence and stable location."""
        self.diagnostics.append(
            PythonI18nDiagnostic(
                rule=rule,
                file=_stable_file(self.path),
                line=getattr(node, "lineno", 1),
                message=message,
                source=ast.get_source_segment(self.source, node) or type(node).__name__,
                code=code,
            )
        )

    def _inspect_public_payload(
        self, node: ast.AST | None, *, response_rule: str
    ) -> None:
        """Reject locale prose and active exception serialization in one public payload."""
        for field, value in _dict_items(node).items():
            if field in PUBLIC_TEXT_FIELDS and _literal_string(value):
                self._report(
                    response_rule,
                    value,
                    f"public field {field} must use a stable code and named params",
                )
        serialization = _find_exception_serialization(node, self._exception_aliases())
        if serialization is not None:
            self._report(
                "python.publicExceptionLeak",
                serialization,
                "raw exception serialization cannot cross a public product boundary",
            )
            return
        tainted = self._tainted_evidence(node)
        if tainted is not None:
            self._report(
                "python.publicExceptionLeak",
                tainted,
                "persisted or relayed exception data cannot cross a public product boundary",
            )
            return
        diagnostic = self._raw_diagnostic_evidence(node)
        if diagnostic is not None:
            self._report(
                "python.publicExceptionLeak",
                diagnostic,
                "raw diagnostic fields require canonical public projection",
            )
            return
        unsafe_projector = self._unsafe_projector_evidence(node)
        if unsafe_projector is not None:
            self._report(
                "python.publicExceptionLeak",
                unsafe_projector,
                "raw error projector cannot cross a public product boundary",
            )

    def _inspect_typed_response(self, node: ast.Call) -> None:
        """Reject raw current-exception serialization inside a typed response model."""
        public_arguments = [
            *node.args,
            *(
                keyword.value
                for keyword in node.keywords
                if keyword.arg not in {"internal", "internal_context"}
            ),
        ]
        serialization = next(
            (
                leaked
                for argument in public_arguments
                if (
                    leaked := _find_exception_serialization(
                        argument, self._exception_aliases()
                    )
                )
                is not None
            ),
            None,
        )
        if serialization is not None:
            self._report(
                "python.publicExceptionLeak",
                serialization,
                "raw exception serialization cannot cross a typed response boundary",
            )
            return
        tainted = self._tainted_evidence(node)
        if tainted is not None:
            self._report(
                "python.publicExceptionLeak",
                tainted,
                "persisted or relayed exception data cannot cross a typed response boundary",
            )
            return
        diagnostic = self._raw_diagnostic_evidence(node)
        if diagnostic is not None:
            self._report(
                "python.publicExceptionLeak",
                diagnostic,
                "raw diagnostic fields require canonical typed response projection",
            )
            return
        unsafe_projector = self._unsafe_projector_evidence(node)
        if unsafe_projector is not None:
            self._report(
                "python.publicExceptionLeak",
                unsafe_projector,
                "raw error projector cannot cross a typed response boundary",
            )

    def _inspect_agent_reply(self, node: ast.Call) -> None:
        """Reject raw diagnostics and fixed Chinese constants at explicit Agent reply sinks."""
        self._inspect_typed_response(node)
        for field in ("reply", "reply_fragment"):
            value = _call_argument(node, field, None)
            literal = self._resolved_literal_string(value)
            if literal is not None and _contains_cjk(literal):
                self._report(
                    "python.fixedAgentReplyLocale",
                    value or node,
                    "Agent reply constants must be selected through LanguageContext",
                )

    def _fixed_product_text_evidence(self, node: ast.AST | None) -> ast.AST | None:
        """Return fixed prose syntax unless a controlled localizer or raw marker owns the value."""
        if node is None:
            return None
        if isinstance(node, ast.Call) and _call_name(node).rsplit(".", 1)[-1] in {
            "RawSourceMarker",
            "localized_compat_text",
        }:
            return None
        if isinstance(node, ast.Name) and node.id in self._fixed_text_locals():
            return self._fixed_text_locals()[node.id]
        literal = self._resolved_literal_string(node)
        if literal:
            return node
        if isinstance(node, ast.JoinedStr) and any(
            isinstance(part, ast.Constant)
            and isinstance(part.value, str)
            and bool(part.value.strip())
            for part in node.values
        ):
            return node
        if isinstance(node, ast.IfExp) and (
            self._fixed_product_text_evidence(node.body) is not None
            or self._fixed_product_text_evidence(node.orelse) is not None
        ):
            return node
        if isinstance(node, ast.BoolOp) and any(
            self._fixed_product_text_evidence(value) is not None
            for value in node.values
        ):
            return node
        if (
            isinstance(node, ast.BinOp)
            and isinstance(node.op, ast.Add)
            and any(
                bool((_literal_string(child) or "").strip()) for child in ast.walk(node)
            )
        ):
            return node
        if isinstance(node, ast.List | ast.Set | ast.Tuple) and any(
            self._fixed_product_text_evidence(element) is not None
            for element in node.elts
        ):
            return node
        if isinstance(node, ast.GeneratorExp) and any(
            self._fixed_product_text_evidence(generator.iter) is not None
            for generator in node.generators
        ):
            return node
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if (
                node.func.attr == "join"
                and node.args
                and self._fixed_product_text_evidence(node.args[0]) is not None
            ):
                return node
            if (
                node.func.attr == "get"
                and len(node.args) > 1
                and self._fixed_product_text_evidence(node.args[1]) is not None
            ):
                return node
            if (
                node.func.attr == "strip"
                and self._fixed_product_text_evidence(node.func.value) is not None
            ):
                return node
        return None

    def _inspect_product_text_value(
        self, node: ast.AST | None, *, boundary: str
    ) -> None:
        """Report fixed prose at one already-proven typed product boundary."""
        evidence = self._fixed_product_text_evidence(node)
        if evidence is not None:
            self._report(
                "python.productNaturalText",
                evidence,
                f"{boundary} must select product prose through LanguageContext",
            )

    def _inspect_product_text_fields(
        self, node: ast.AST | None, *, boundary: str
    ) -> None:
        """Inspect text-shaped keys in nested dictionaries owned by one proven product sink."""
        if node is None:
            return
        for candidate in ast.walk(node):
            if not isinstance(candidate, ast.Dict):
                continue
            for field, value in _dict_items(candidate).items():
                if field in {"detail", "status_text", "text"}:
                    self._inspect_product_text_value(value, boundary=boundary)

    def _inspect_task_result(self, node: ast.Call) -> None:
        """Reject fixed reply fragments without reclassifying structured result-to-result errors."""
        self._inspect_product_text_value(
            _call_argument(node, "reply_fragment", None),
            boundary="TaskExecutionResult.reply_fragment",
        )

    def _inspect_stream_status(self, node: ast.Call) -> None:
        """Reject fixed text passed through the compatibility stream-status event helper."""
        self._inspect_product_text_value(
            _call_argument(node, "text", self.stream_status_text_position),
            boundary="_add_stream_status_event text",
        )

    def _inspect_agent_event_text(self, node: ast.Call) -> None:
        """Reject fixed text-shaped fields inside the durable AgentEvent payload only."""
        payload = next(
            (
                keyword.value
                for keyword in node.keywords
                if keyword.arg in {"data", "payload", "payload_json"}
            ),
            None,
        )
        self._inspect_product_text_fields(payload, boundary="AgentEvent payload")

    def _in_product_projection_function(self) -> bool:
        """Prove a trace, progress, or draft projection from its narrow function contract name."""
        if not self._function_name_stack:
            return False
        function_name = self._function_name_stack[-1].lower()
        return function_name.endswith("trace_line") or (
            "project" in function_name
            and any(token in function_name for token in ("draft", "progress", "trace"))
        )

    def _inspect_job_failure(self, node: ast.Call) -> None:
        """Reject raw current-exception serialization relayed through an SSE job failure."""
        serialization = _find_exception_serialization(node, self._exception_aliases())
        if serialization is not None:
            self._report(
                "python.publicExceptionLeak",
                serialization,
                "raw exception serialization cannot cross a public job failure boundary",
            )

    def _inspect_public_relay(self, node: ast.Call) -> None:
        """Reject current or locally relayed exception data entering a queue, webhook, or span."""
        serialization = _find_exception_serialization(node, self._exception_aliases())
        if serialization is not None:
            self._report(
                "python.publicExceptionLeak",
                serialization,
                "raw exception serialization cannot cross a public relay boundary",
            )
            return
        raw_alias = _find_name_reference(node, self._exception_aliases())
        if raw_alias is not None:
            self._report(
                "python.publicExceptionLeak",
                raw_alias,
                "caught exceptions cannot enter a public relay boundary",
            )
            return
        tainted = self._tainted_evidence(node)
        if tainted is not None:
            self._report(
                "python.publicExceptionLeak",
                tainted,
                "relayed exception data cannot cross a public relay boundary",
            )
            return
        diagnostic = self._raw_diagnostic_evidence(node)
        if diagnostic is not None:
            self._report(
                "python.publicExceptionLeak",
                diagnostic,
                "raw diagnostic fields require canonical public relay projection",
            )

    def _inspect_span_failure(self, node: ast.Call) -> None:
        """Reject a caught exception handed to a span whose payload is product-readable."""
        leaked = _find_name_reference(node, self._exception_aliases())
        if leaked is not None:
            self._report(
                "python.publicExceptionLeak",
                leaked,
                "caught exceptions cannot enter a product-readable span",
            )

    def _inspect_http_exception(self, node: ast.Call) -> None:
        """Require structured safe detail for HTTPException rather than product prose or causes."""
        detail = next(
            (keyword.value for keyword in node.keywords if keyword.arg == "detail"),
            None,
        )
        if _literal_string(detail):
            self._report(
                "python.httpNaturalDetail",
                detail or node,
                "HTTPException.detail cannot be final natural-language UI text",
            )
        elif isinstance(detail, ast.JoinedStr):
            self._report(
                "python.httpNaturalDetail",
                detail,
                "formatted HTTPException.detail cannot be a public product contract",
            )
        self._inspect_public_payload(detail, response_rule="python.httpNaturalDetail")

    def _is_safe_public_error_detail(self, node: ast.AST | None) -> bool:
        """Accept only a registered code/message key at the deprecated Public API detail sink."""
        if node is None:
            return True
        literal = self._resolved_literal_string(node)
        if literal is not None:
            return literal in self.registered_codes
        if self._is_guarded_dynamic_code(node) or _is_registry_guarded_public_field(
            node, self.guarded_registry_names
        ):
            return True
        if (
            isinstance(node, ast.Subscript)
            and _literal_string(node.slice) in {"code", "message_key"}
            and _subscript_root_name(node) in self._canonical_locals()
        ):
            return True
        return (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "get"
            and len(node.args) == 1
            and _literal_string(node.args[0]) in {"code", "message_key"}
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id in self._canonical_locals()
        )

    def _inspect_problem_response(self, node: ast.Call) -> None:
        """Check the exact problem_response detail sink without treating legacy constructor input as UI."""
        code_node = _call_argument(node, "code", None)
        code = self._resolved_literal_string(code_node)
        if code is None:
            if not self._is_guarded_dynamic_code(code_node):
                self._report(
                    "python.dynamicErrorCode",
                    code_node or node,
                    "problem_response code requires an explicit registry guard",
                )
        elif code not in self.registered_codes:
            self._report(
                "python.unregisteredDescriptor",
                code_node or node,
                "problem_response code is absent from the stable registry",
                code=code,
            )
        else:
            params_node = _call_argument(node, "params", None)
            expected_params = self.registered_error_params.get(code)
            if expected_params is not None:
                actual_params = (
                    set(_dict_items(params_node))
                    if isinstance(params_node, ast.Dict)
                    else set()
                )
                if actual_params != expected_params:
                    self._report(
                        "python.errorParamsMismatch",
                        params_node or node,
                        "problem_response params do not match the registered parameter names",
                        code=code,
                    )

        detail = _call_argument(node, "detail", None)
        if self._is_safe_public_error_detail(detail):
            return
        evidence = _find_exception_serialization(detail, self._exception_aliases())
        if evidence is None:
            evidence = _find_raw_diagnostic_reference(detail) or detail or node
        self._report(
            "python.publicErrorDetail",
            evidence,
            "problem_response detail must use a registered code or message key",
        )

    def _inspect_problem_response_assignment(
        self, target: ast.Subscript, value: ast.AST
    ) -> None:
        """Reject direct caller-detail assignment inside the canonical problem_response implementation."""
        if not self._function_name_stack or self._function_name_stack[-1] != "problem_response":
            return
        if _subscript_key(target) != "detail":
            return
        if self._is_safe_public_error_detail(value):
            return
        evidence = _find_exception_serialization(value, self._exception_aliases())
        if evidence is None:
            evidence = _find_raw_diagnostic_reference(value) or value
        self._report(
            "python.publicErrorDetail",
            evidence,
            "problem_response detail assignment must use a registered code or message key",
        )

    def _inspect_problem_response_dict(self, node: ast.AST | None) -> None:
        """Reject detail entries embedded directly in a problem_response payload literal."""
        if not self._function_name_stack or self._function_name_stack[-1] != "problem_response":
            return
        for candidate in ast.walk(node) if node is not None else ():
            if not isinstance(candidate, ast.Dict):
                continue
            detail = _dict_items(candidate).get("detail")
            if detail is None or self._is_safe_public_error_detail(detail):
                continue
            evidence = _find_exception_serialization(detail, self._exception_aliases())
            if evidence is None:
                evidence = _find_raw_diagnostic_reference(detail) or detail
            self._report(
                "python.publicErrorDetail",
                evidence,
                "problem_response detail payload must use a registered code or message key",
            )

    def _inspect_response(self, node: ast.Call) -> None:
        """Inspect the response content argument while leaving headers and technical status intact."""
        payload = (
            node.args[0]
            if node.args
            else next(
                (
                    keyword.value
                    for keyword in node.keywords
                    if keyword.arg in {"content", "data"}
                ),
                None,
            )
        )
        self._inspect_public_payload(
            payload, response_rule="python.responseNaturalText"
        )

    def _inspect_legacy_event(self, node: ast.Call) -> None:
        """Reject text-shaped legacy event payload fields that cannot be localized on replay."""
        payload = (
            node.args[3]
            if len(node.args) > 3
            else next(
                (
                    keyword.value
                    for keyword in node.keywords
                    if keyword.arg == "payload"
                ),
                None,
            )
        )
        for field, value in _dict_items(payload).items():
            if field in PUBLIC_TEXT_FIELDS and _literal_string(value):
                self._report(
                    "python.eventNaturalText",
                    value,
                    f"event field {field} must be a registered code/param projection",
                )
        if payload is not None:
            self._report(
                "python.unstructuredEventPayload",
                payload,
                "EventLog.record payload must use a registered SystemEvent contract",
            )

    def _inspect_descriptor(self, node: ast.Call) -> None:
        """Require one built-in or wrapper error call to use a registered, schema-safe contract."""
        short_name = _call_name(node).rsplit(".", 1)[-1]
        if (
            short_name == "ErrorDescriptor"
            and self._function_name_stack
            and self._function_name_stack[-1] in self.validated_failure_wrappers
        ):
            return
        if (
            short_name in self.validated_error_types
            or short_name in self.validated_error_wrappers
        ):
            return
        wrapper = self.error_wrappers.get(short_name)
        if wrapper is not None:
            code_node = _call_argument(
                node, wrapper.code_parameter, wrapper.code_position
            )
            params_node = (
                _call_argument(node, wrapper.params_parameter, wrapper.params_position)
                if wrapper.params_parameter
                else None
            )
        else:
            code_node = _call_code_argument(node, short_name)
            params_node = _call_params_argument(node, short_name)
        if short_name == "_failure":
            # `_failure` deliberately keeps its message and cause in private diagnostics;
            # only code and canonical params are part of the public contract.
            public_arguments = [
                node.args[0] if node.args else node,
                *(
                    keyword.value
                    for keyword in node.keywords
                    if keyword.arg not in {
                        "cause",
                        "details",
                        "internal",
                        "internal_context",
                        "message",
                        "params",
                    }
                ),
            ]
        else:
            public_arguments = [
                *node.args,
                *(
                    keyword.value
                    for keyword in node.keywords
                    if keyword.arg not in {"internal", "internal_context"}
                ),
            ]
        serialization = next(
            (
                leaked
                for argument in public_arguments
                if (
                    leaked := _find_exception_serialization(
                        argument, self._exception_aliases()
                    )
                )
                is not None
            ),
            None,
        )
        if serialization is not None:
            self._report(
                "python.publicExceptionLeak",
                serialization,
                "raw exception serialization cannot enter a public error object",
            )
        if code_node is None and short_name in {
            "KnowledgeError",
            "ToolError",
        }:
            return
        code = self._resolved_literal_string(code_node)
        if code is None:
            if id(node) in self.forwarding_calls or self._is_guarded_dynamic_code(
                code_node
            ):
                return
            self._report(
                "python.dynamicErrorCode",
                code_node or node,
                "dynamic public error code requires an explicit registry guard",
            )
            return
        if code not in self.registered_codes:
            self._report(
                "python.unregisteredDescriptor",
                code_node or node,
                "public error code is absent from the stable registry",
                code=code,
            )
            return
        expected_params = self.registered_error_params.get(code)
        if expected_params is None:
            return
        actual_params = (
            set(_dict_items(params_node))
            if isinstance(params_node, ast.Dict)
            else set()
        )
        if actual_params != expected_params:
            self._report(
                "python.errorParamsMismatch",
                params_node or node,
                "public error params do not match the registered parameter names",
                code=code,
            )

    def _inspect_natural_detail_wrapper(self, node: ast.Call) -> None:
        """Reject unregistered code or natural message arguments passed through an HTTP helper."""
        short_name = _call_name(node).rsplit(".", 1)[-1]
        wrapper = self.natural_detail_wrappers[short_name]
        code_node = _call_argument(node, wrapper.code_parameter, wrapper.code_position)
        code = self._resolved_literal_string(code_node)
        if code is None:
            if not self._is_guarded_dynamic_code(code_node):
                self._report(
                    "python.dynamicErrorCode",
                    code_node or node,
                    "dynamic legacy HTTP code requires an explicit registry guard",
                )
        elif code not in self.registered_codes:
            self._report(
                "python.unregisteredDescriptor",
                code_node or node,
                "legacy HTTP helper code is absent from the stable registry",
                code=code,
            )
        message_node = _call_argument(
            node,
            wrapper.message_parameter,
            wrapper.message_position,
        )
        if _literal_string(message_node):
            self._report(
                "python.httpNaturalDetail",
                message_node or node,
                "HTTP helper message cannot be final natural-language UI text",
            )
            return
        serialization = _find_exception_serialization(
            message_node, self._exception_aliases()
        )
        if serialization is not None:
            self._report(
                "python.publicExceptionLeak",
                serialization,
                "raw exception serialization cannot cross an HTTP helper boundary",
            )

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        """Track FastAPI-decorated handlers so direct returned dict payloads are treated as public."""
        is_route = any(
            isinstance(decorator, ast.Call)
            and isinstance(decorator.func, ast.Attribute)
            and decorator.func.attr.lower() in {"delete", "get", "patch", "post", "put"}
            for decorator in node.decorator_list
        )
        # Workflow: isolate per-function data flow before traversing nested public boundaries.
        self._route_depth += int(is_route)
        self._local_taint_stack.append(set())
        self._fixed_text_local_stack.append({})
        self._canonical_local_stack.append(set())
        self._guarded_code_stack.append(
            set(self.guarded_code_names.get(id(node), set()))
        )
        self._function_name_stack.append(node.name)
        self.generic_visit(node)
        self._function_name_stack.pop()
        self._guarded_code_stack.pop()
        self._fixed_text_local_stack.pop()
        self._canonical_local_stack.pop()
        self._local_taint_stack.pop()
        self._route_depth -= int(is_route)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        """Apply the same public-route tracking to asynchronous FastAPI handlers."""
        self.visit_FunctionDef(node)  # type: ignore[arg-type]

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        """Limit raw-exception recognition to the body of its matching except handler."""
        calls = [child for child in ast.walk(node) if isinstance(child, ast.Call)]
        call_names = {_call_name(call) for call in calls}
        function_name = (
            self._function_name_stack[-1] if self._function_name_stack else ""
        )
        handled_types = _except_type_names(node)
        is_control_flow = any(
            name.endswith(("Cancelled", "ValidationError")) for name in handled_types
        )
        job_boundary = "job" in function_name.lower() and any(
            name.rsplit(".", 1)[-1]
            in {"ErrorDescriptor", "JobResponse", "_terminalize_job", "fail"}
            for name in call_names
        )
        has_private_cause = any(
            name.endswith("logger.exception")
            or name.rsplit(".", 1)[-1] == "InternalErrorContext"
            for name in call_names
        ) or any(
            isinstance(child, ast.Raise) and child.cause is not None
            for child in ast.walk(node)
        )
        if job_boundary and not is_control_flow and not has_private_cause:
            self._report(
                "python.missingPrivateCause",
                node,
                "public job failure must retain its root cause in authorized private diagnostics",
            )
        self._exception_alias_stack.append({node.name} if node.name else set())
        for statement in node.body:
            self.visit(statement)
        self._exception_alias_stack.pop()

    def visit_Assign(self, node: ast.Assign) -> None:
        """Track exception data and reject fixed prose assigned to a task reply fragment."""
        tainted_locals = self._tainted_locals()
        fixed_text_locals = self._fixed_text_locals()
        serialization = _find_result_exception_serialization(
            node.value, self._exception_aliases()
        )
        value_is_tainted = (
            serialization is not None
            or self._references_persisted_exception(node.value)
        )
        canonical_projector = isinstance(node.value, ast.Call) and (
            _call_name(node.value).rsplit(".", 1)[-1] in self.safe_error_projectors
        )
        self._inspect_problem_response_dict(node.value)

        # Workflow: update simple local data flow, then inspect explicit public subscript sinks.
        for target in node.targets:
            if isinstance(target, ast.Attribute) and target.attr == "reply_fragment":
                self._inspect_product_text_value(
                    node.value,
                    boundary="TaskExecutionResult.reply_fragment assignment",
                )
            if isinstance(target, ast.Subscript):
                self._inspect_problem_response_assignment(target, node.value)
            if isinstance(target, ast.Name):
                if canonical_projector:
                    self._canonical_locals().add(target.id)
                else:
                    self._canonical_locals().discard(target.id)
                if value_is_tainted:
                    tainted_locals.add(target.id)
                else:
                    tainted_locals.discard(target.id)
                fixed_text_evidence = self._fixed_product_text_evidence(node.value)
                if fixed_text_evidence is not None:
                    fixed_text_locals[target.id] = fixed_text_evidence
                else:
                    fixed_text_locals.pop(target.id, None)
            elif (
                isinstance(target, ast.Subscript)
                and _subscript_key(target) in PUBLIC_TEXT_FIELDS
            ):
                leaked_name = _find_name_reference(node.value, tainted_locals)
                if leaked_name is not None:
                    self._report(
                        "python.publicExceptionLeak",
                        leaked_name,
                        "persisted raw exception data cannot cross a public payload boundary",
                    )
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        """Route recognized calls to contract, response, event, and relay-specific checks."""
        name = _call_name(node)
        short_name = name.rsplit(".", 1)[-1]
        receiver_name = name.rsplit(".", 1)[0] if "." in name else ""

        # A tainted collection becomes public only when a later checked response consumes it.
        if short_name == "append" and isinstance(node.func, ast.Attribute):
            serialization = _find_exception_serialization(
                node, self._exception_aliases()
            )
            if (
                serialization is not None or self._references_persisted_exception(node)
            ) and isinstance(node.func.value, ast.Name):
                self._tainted_locals().add(node.func.value.id)

        if short_name in HTTP_EXCEPTION_NAMES:
            self._inspect_http_exception(node)
        elif short_name in PROBLEM_RESPONSE_NAMES:
            self._inspect_problem_response(node)
        elif short_name in RESPONSE_NAMES:
            self._inspect_response(node)
        elif short_name in ERROR_CONSTRUCTOR_NAMES or short_name in self.error_wrappers:
            self._inspect_descriptor(node)
        elif short_name in PUBLIC_ERROR_WRAPPER_NAMES:
            if short_name not in self.safe_error_projectors and (
                short_name != "_failure"
                or short_name in self.validated_failure_wrappers
            ):
                self._inspect_descriptor(node)
        elif short_name in self.natural_detail_wrappers:
            self._inspect_natural_detail_wrapper(node)
        elif short_name in AGENT_REPLY_SINK_NAMES:
            self._inspect_agent_reply(node)
        elif short_name in TASK_RESULT_SINK_NAMES:
            self._inspect_task_result(node)
        elif short_name.endswith("Response"):
            self._inspect_typed_response(node)
        elif short_name in FINAL_REPLY_HELPER_NAMES:
            self._inspect_public_relay(node)
        elif name == "stream_jobs.fail":
            self._inspect_job_failure(node)
        elif short_name == "_add_stream_status_event":
            self._inspect_stream_status(node)
        elif short_name in PUBLIC_RELAY_NAMES or (
            short_name == "put" and receiver_name == "terminal"
        ):
            if short_name == "AgentEvent":
                self._inspect_agent_event_text(node)
            self._inspect_public_relay(node)
        elif short_name == "fail" and receiver_name == "span":
            self._inspect_span_failure(node)
        elif short_name == "record" and receiver_name.endswith(("events", "event_log")):
            self._inspect_legacy_event(node)
            self._inspect_public_relay(node)
        self.generic_visit(node)

    def visit_Return(self, node: ast.Return) -> None:
        """Inspect direct dict responses only while inside an explicitly decorated API route."""
        self._inspect_problem_response_dict(node.value)
        if self._route_depth and isinstance(node.value, ast.Dict):
            self._inspect_public_payload(
                node.value, response_rule="python.responseNaturalText"
            )
        if self._in_product_projection_function() and isinstance(node.value, ast.Dict):
            self._inspect_product_text_fields(
                node.value,
                boundary="trace/progress/draft projection",
            )
        function_name = (
            self._function_name_stack[-1] if self._function_name_stack else ""
        )
        if any(
            token in function_name.lower()
            for token in ("cancel", "interrupt", "recover")
        ):
            literal = self._resolved_literal_string(node.value)
            if literal is not None and _contains_cjk(literal):
                self._report(
                    "python.fixedAgentReplyLocale",
                    node.value or node,
                    "Agent cancellation and recovery replies must use LanguageContext",
                )
        self.generic_visit(node)


def check_python_files(
    file_paths: Iterable[Path | str],
    *,
    registered_error_codes: set[str],
    registered_error_params: Mapping[str, set[str]] | None = None,
    allowlist_entries: Sequence[dict[str, object]] = (),
    today: date | None = None,
) -> list[PythonI18nDiagnostic]:
    """Check a deterministic Python file set without importing or executing application modules."""
    current_date = today or datetime.now(UTC).date()
    diagnostics: list[PythonI18nDiagnostic] = []
    paths = sorted((Path(path) for path in file_paths), key=lambda path: str(path))
    sources = {path: path.read_text(encoding="utf-8") for path in paths}
    trees = {
        path: ast.parse(source, filename=str(path)) for path, source in sources.items()
    }

    # Workflow: discover forwarding helpers before checking their literal production callers.
    error_wrappers, forwarding_calls = _collect_error_wrappers(trees)
    natural_detail_wrappers = _collect_natural_detail_wrappers(trees)
    literal_string_names = _literal_strings_by_file(trees)
    safe_error_projectors, unsafe_error_projectors = _collect_public_error_projectors(
        trees
    )
    validated_error_types = _validated_error_types(trees)
    validated_error_wrappers = _validated_error_wrappers_by_path(
        trees, validated_error_types
    )
    validated_failure_wrappers = _validated_failure_wrappers_by_path(trees)

    # Workflow: collect persisted exception fields across files before inspecting API readers.
    persisted_exception_attributes: set[tuple[str, str]] = set()
    for tree in trees.values():
        persistence = _ExceptionPersistenceCollector()
        persistence.visit(tree)
        persisted_exception_attributes.update(persistence.attribute_paths)

    # Workflow: inspect each source with shared wrapper and persistence evidence.
    for raw_path in paths:
        source = sources[raw_path]
        tree = trees[raw_path]
        visitor = _BoundaryVisitor(
            raw_path,
            source,
            registered_error_codes,
            registered_error_params or {},
            persisted_exception_attributes,
            error_wrappers,
            natural_detail_wrappers,
            forwarding_calls,
            _guarded_registry_names(tree),
            _guarded_code_names_by_function(tree),
            literal_string_names[raw_path],
            safe_error_projectors[raw_path],
            unsafe_error_projectors[raw_path],
            validated_error_types,
            validated_error_wrappers[raw_path],
            validated_failure_wrappers[raw_path],
            _stream_status_text_position(tree),
        )
        visitor.visit(tree)
        diagnostics.extend(
            diagnostic
            for diagnostic in visitor.diagnostics
            if not _is_allowlisted(diagnostic, allowlist_entries, current_date)
        )
    unique_diagnostics = {
        (item.rule, item.file, item.line, item.source, item.code): item
        for item in diagnostics
    }
    return sorted(
        unique_diagnostics.values(),
        key=lambda item: (
            item.file,
            item.line,
            item.rule,
            item.code or "",
            item.source,
        ),
    )


def format_diagnostics(
    diagnostics: Sequence[PythonI18nDiagnostic], format_name: str = "human"
) -> str:
    """Serialize findings for terminal readers or deterministic JSON CI artifacts."""
    if format_name == "json":
        return json.dumps(
            [asdict(item) for item in diagnostics], ensure_ascii=False, indent=2
        )
    if format_name != "human":
        raise ValueError(f"unsupported diagnostics format: {format_name}")
    return "\n".join(
        f"{item.file}:{item.line}: {item.severity} {item.rule} {item.message}"
        for item in diagnostics
    )


def _registered_contracts_from_source(path: Path) -> dict[str, set[str]]:
    """Extract literal registry codes and parameter names without importing application state."""
    if not path.exists():
        return {}
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    contracts: dict[str, set[str]] = {}
    for node in ast.walk(tree):
        if (
            not isinstance(node, ast.Call)
            or _call_name(node).rsplit(".", 1)[-1] != "ErrorRegistryEntry"
        ):
            continue
        code_node = next(
            (keyword.value for keyword in node.keywords if keyword.arg == "code"),
            None,
        )
        code = _literal_string(code_node)
        if code:
            params_node = next(
                (
                    keyword.value
                    for keyword in node.keywords
                    if keyword.arg == "params_schema"
                ),
                None,
            )
            contracts[code] = set(_dict_items(params_node))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign) or not isinstance(
            node.value, ast.Tuple | ast.List
        ):
            continue
        for item in node.value.elts:
            if not isinstance(item, ast.Tuple) or not item.elts:
                continue
            code = _literal_string(item.elts[0])
            if code is None or not code.isupper():
                continue
            params_node = item.elts[-1] if isinstance(item.elts[-1], ast.Dict) else None
            contracts[code] = set(_dict_items(params_node))
    return contracts


def _registered_codes_from_source(path: Path) -> set[str]:
    """Retain the code-only extraction API for callers that do not validate parameter schemas."""
    return set(_registered_contracts_from_source(path))


def _load_allowlist(path: Path) -> list[dict[str, object]]:
    """Load the exact Python compatibility allowlist and reject ambiguous shapes."""
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    if payload.get("schemaVersion") != 1 or not isinstance(
        payload.get("entries"), list
    ):
        raise ValueError("Python i18n allowlist requires schemaVersion 1 and entries")
    return list(payload["entries"])


def _build_parser() -> argparse.ArgumentParser:
    """Create the fail-closed CLI parser used by local and CI entry points."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("files", nargs="*", type=Path)
    parser.add_argument("--registered-code", action="append", default=[])
    parser.add_argument("--format", choices=("human", "json"), default="human")
    parser.add_argument(
        "--allowlist",
        type=Path,
        default=REPOSITORY_ROOT / "scripts" / "i18n" / "legacy-allowlist.json",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the repository gate, writing diagnostics to stderr and returning a process status."""
    args = _build_parser().parse_args(argv)
    files = args.files or sorted((REPOSITORY_ROOT / "backend" / "app").rglob("*.py"))
    registry_path = (
        REPOSITORY_ROOT / "backend" / "app" / "contracts" / "error_registry.py"
    )
    registered_contracts = _registered_contracts_from_source(registry_path)
    registered_codes = set(args.registered_code) or set(registered_contracts)
    registered_params = (
        {code: registered_contracts.get(code, set()) for code in registered_codes}
        if not args.registered_code
        else {}
    )
    diagnostics = check_python_files(
        files,
        registered_error_codes=registered_codes,
        registered_error_params=registered_params,
        allowlist_entries=_load_allowlist(args.allowlist),
    )
    if diagnostics:
        import sys

        sys.stderr.write(f"{format_diagnostics(diagnostics, args.format)}\n")
        return 1
    print(f"backend i18n governance OK: {len(files)} files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
