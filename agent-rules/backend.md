# Backend Development

- Backend code is in `backend/app/`; tests are in `backend/tests/`. The supported
  conversation runtime is Harness v2; `backend/single_port_app.py` supports the
  single-port and desktop runtime.
- Install missing backend dependencies with `python3 -m venv backend/.venv` and
  `backend/.venv/bin/python -m pip install -e "backend[dev]"`.
- Use Python 3.11+, four-space indentation, type hints, `snake_case` functions
  and modules, and `PascalCase` classes. Ruff uses a 100-character line limit.
- Validate changed backend paths with relevant tests, then run
  `backend/.venv/bin/python -m pytest backend/tests` and
  `backend/.venv/bin/ruff check backend` when scope and dependencies permit.
