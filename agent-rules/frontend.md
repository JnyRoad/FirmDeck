# Frontend Development

- React/TypeScript code is in `frontend-enterprise/src/`; static assets are in
  `frontend-enterprise/public/`; tests are colocated as `*.test.ts(x)`.
- Install locked frontend dependencies with `npm --prefix frontend-enterprise ci`.
- Keep TypeScript strict; use two spaces, single quotes, semicolons, `PascalCase`
  components, `use...` hooks, and the `@/` import alias where applicable.
- Add focused regression tests for changed behavior. Run the relevant Vitest
  tests and, when scope and dependencies permit,
  `npm --prefix frontend-enterprise test` and
  `npm --prefix frontend-enterprise run build`.
- When changing Vite environment usage, run
  `npm --prefix frontend-enterprise run config:check`.
- For visible UI changes, verify the affected route and user role in a browser.
