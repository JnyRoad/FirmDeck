# Release and Versioning

Platform release assets live in `packaging/`.

`backend/VERSION` (bare semver) is the version source of truth.
`backend/pyproject.toml` reads it dynamically; never edit its version field.
When changing `backend/VERSION`, run `scripts/sync_version.py` in the same
commit so `frontend-enterprise/package.json` remains aligned.

Only change versions for releases. Use patch for compatible fixes, minor for
backward-compatible features, and major for breaking changes; before 1.0,
breaking changes also bump minor. Release flow: update the version, sync it,
commit, merge, tag the matching `vX.Y.Z`, then push the tag.
