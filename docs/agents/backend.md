# 后端开发

- 后端代码位于 `backend/app/`，测试位于 `backend/tests/`。支持的会话运行时为 Harness
  v2；`backend/single_port_app.py` 支持单端口和桌面端运行时。
- 使用 `python3 -m venv backend/.venv` 和
  `backend/.venv/bin/python -m pip install -e "backend[dev]"` 安装缺失的后端依赖。
- 使用 Python 3.11+、四空格缩进、类型标注、`snake_case` 函数与模块，以及 `PascalCase`
  类名。Ruff 的单行长度限制为 100 个字符。
- 先用相关测试验证已改动的后端路径；当改动范围和依赖条件允许时，再运行
  `backend/.venv/bin/python -m pytest backend/tests` 和
  `backend/.venv/bin/ruff check backend`。
