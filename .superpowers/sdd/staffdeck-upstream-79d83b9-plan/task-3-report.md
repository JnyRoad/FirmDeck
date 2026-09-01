# Task 3 Report — WeChat Customer Service setup UI

## Scope and outcome

- Added the dedicated `wechat_kf` setup route and localized channel presentation without changing ordinary WeChat QR-code routing.
- Added typed frontend contracts and client methods for callback preparation, credentials, account list/select/create/update/delete, avatar upload, contact-way generation, and public binding fields.
- Added a dedicated responsive setup UI with permission gating, loading/error states, destructive confirmation, local JPG/PNG and 2 MiB avatar validation, QR rendering, and accessible copy/actions.
- Added semantic `en-US` / `zh-CN` messages, the checked-in `en-XA` artifact, and the channels i18n manifest. Provider names, IDs, URLs, `open_kfid`, and callback values remain raw content.
- Opened `wechat_kf` in channel metadata only after the frontend and locale tests were green. No Task 2 data model, endpoint, callback, or account-operation state-machine code was changed.

## TDD evidence

### RED

1. `npm --prefix frontend-enterprise test -- src/api/client.test.ts src/pages/channelPresentation.test.ts src/pages/ChannelsPage.test.tsx`
   - 3 failures: missing typed client export, missing built-in presentation, and `wechat_kf` incorrectly falling through to the legacy setup path.
2. `npm --prefix frontend-enterprise test -- src/pages/channels/WechatKfSetup.test.tsx`
   - 7/7 failures before the dedicated component behavior was implemented.
3. `backend/.venv/bin/pytest -q backend/tests/test_wechat_kf_api.py::test_wechat_kf_metadata_is_visible_with_dedicated_setup_without_changing_existing_channels`
   - Failed with `KeyError: 'wechat_kf'` while metadata was still intentionally hidden.
4. Focused contact-way test after adding the QR assertion:
   - 1 expected failure because the generated contact URL had no accessible QR image.

### GREEN

- Typed client, presentation, and page routing: 33 tests passed at the first GREEN checkpoint.
- Dedicated setup flows: the original 7/7 tests passed after implementation; QR generation was independently driven RED then GREEN, and the final component suite is 8/8 after adding an explicit credential-failure non-echo regression.
- Final related frontend suite: 5 files, 49 tests passed, 0 failed.
- Exact metadata suite: 3 tests passed, including the new `wechat_kf` setup assertion and existing WeChat/WeCom/Feishu metadata regressions.

## Covered user flows

- Two-locale read-only permission state with raw Corp ID, provider name, and `open_kfid` preservation.
- Callback preparation loading state, raw URL/token/AES-key display, and keyboard-operable copy actions.
- Secret save with success/failure clearing and no response/binding/DOM echo.
- Provider account list, selection, provider management-permission state, creation, update, and confirmed deletion.
- Local avatar MIME/size rejection without a request, multipart upload, and clearing the browser file selection after upload.
- Contact-way generation, local QR-code rendering, raw link display, and copy.
- Safe fallback errors that do not render provider response prose.

## Verification

- `npm --prefix frontend-enterprise test -- src/api/client.test.ts src/pages/channelPresentation.test.ts src/pages/ChannelsPage.test.tsx src/pages/channels/WechatKfSetup.test.tsx src/pages/channels/channels.i18n.test.tsx` — **PASS**, 49/49.
- `npm --prefix frontend-enterprise run i18n:check` — **PASS**, 4,415 semantic messages; backend contract and `en-XA` current.
- `npm --prefix frontend-enterprise run config:check` — **PASS**.
- `npm --prefix frontend-enterprise run build` — **PASS** (`tsc -b` and Vite); Vite reports the existing large-chunk advisory only.
- `backend/.venv/bin/ruff check --select F backend/app/api/channels.py backend/tests/test_wechat_kf_api.py` — **PASS**.
- Exact backend metadata regression command — **PASS**, 3/3.
- `git diff --check` — **PASS**.

An exploratory unscoped `ruff check` over the two backend files reports 52 existing repository-style findings (`B008`, `DTZ005`, and `BLE001`) outside the Task 3 diff. They were not changed because this task only opens one metadata set member and must not refactor Task 2/backend behavior.

## Security and boundary self-review

- Application Secret exists only in controlled component state and the immediate request body; it is cleared after both success and failure and is absent from binding types, local/session storage, logs, URL parameters, and rendered response state.
- Callback token and AES key are intentionally one-time preparation values needed for provider configuration; they are not persisted by the frontend.
- File objects are not stored outside component state and the multipart request; invalid files are discarded locally and valid file selection is reset after upload.
- Provider errors use canonical descriptors or stable semantic fallbacks; raw response bodies are not used as UI text.
- Metadata exposure is limited to `wechat_kf`; existing channel setup values are asserted unchanged.

## Risks and unverified items

- Real-browser responsive/clipboard/file-picker/QR rendering is **UNVERIFIED**; coverage is jsdom plus production TypeScript/Vite build.
- Real WeChat Customer Service provider callback, account mutations, avatar media, and contact-way behavior is **UNVERIFIED** by scope; tests use the committed Task 2 contract and mocked provider-facing responses.
- The codebase-memory generation predates this diff and reports changed/not-tracked metadata for implementation files and designed exclusions for several tests/i18n catalogs. Final claims therefore rely on direct source reads and executed tests, not fresh graph completeness.

## Provenance

Implementation follows the approved StaffDeck upstream-gap plan and references upstream provenance `79d83b9` without copying legacy locale architecture.

---

## Fix round 1/5 — account collection, transient secrets, and safe contact links

### Outcome

- Name-only account updates now omit `media_id`; create still requires a successfully uploaded avatar media ID.
- Callback values are scoped to the normalized Corp ID that prepared them. Starting another prepare, editing the Corp ID, or a prepare failure clears the old callback token/AES key, so Corp A values cannot be submitted as Corp B values. A Corp ID already projected by the binding remains locked in the input, matching the Task 2 immutable identity contract.
- Saving credentials snapshots and immediately clears the Secret before client validation or network work. Corp/Secret fields and credential actions are disabled while the operation is pending, and neither HTTP nor network error text can re-render the Secret.
- Provider accounts are modeled as a collection. Status comes exclusively from `bound` plus `bound_binding_id`: current-binding accounts expose management actions, other-binding accounts expose neither Select nor current-binding actions, and the invented singular “Selected” state was removed.
- Select/create/update/delete success now performs a complete provider-list refresh. A request generation prevents older list responses from overwriting the current binding. Mutation success followed by refresh failure uses a distinct semantic message and does not pretend the mutation rolled back.
- Invalid avatar selections immediately reset both the native FileList and the React file input instance. Delete confirmation retains the exact target account object and displays its raw name and `open_kfid`.
- Contact-way output is fail-closed: only HTTPS URLs without username/password and with the exact allowlisted host `work.weixin.qq.com` can produce a link, QR, or copy action. The valid raw URL is rendered as a real link with `target="_blank"` and `rel="noopener noreferrer"`.

### TDD evidence

#### RED

1. Callback/Secret/name-only cluster: `WechatKfSetup.test.tsx` ran 11 tests with 3 expected failures (stale callback remained visible, client validation retained Secret, and name-only update required an avatar).
2. Account collection/reconciliation cluster: 14 tests ran with 6 expected failures (singular selected state, other-binding actions, absent post-mutation refreshes, missing refresh-failure semantics, and stale list overwrite).
3. Contact URL/native file-input cluster: 19 tests ran with 7 expected failures (two native FileList reset paths plus valid-link semantics and five unsafe URL classes).

#### GREEN

- Dedicated component suite: **19/19 passed**.
- Related frontend suite (`client`, presentation, ChannelsPage, dedicated setup, channels i18n): **60/60 passed**.
- Semantic i18n governance: **4,418 messages verified**, including current `en-XA` and backend contract.
- Exact backend metadata regressions: **3/3 passed**; this fix round did not change backend code or the Task 2 state machine.

### Added regression coverage

- Callback success → Corp ID edit → prepare failure cannot display the old token/AES key.
- Missing-Corp client validation clears the Secret; pending credential requests disable inputs; rejected network requests do not echo Secret/error prose.
- Name-only PATCH has no `media_id`; empty-list create appears after refresh; select refreshes `bound`; update refreshes provider name/avatar; delete removes the exact confirmed target.
- A successful mutation with failed follow-up refresh remains successful and reports a distinct list-sync error; an older binding request cannot overwrite a newer binding list.
- `bound=true` with another `bound_binding_id` has a distinct status and no Select/edit actions.
- Invalid avatar MIME and size both clear the browser FileList immediately.
- Valid contact-way output is a raw accessible link plus QR/copy; JavaScript, HTTP, credential-bearing, wrong-host, and malformed values produce none of those outputs.

### Final verification

- `npm --prefix frontend-enterprise test -- src/pages/channels/WechatKfSetup.test.tsx` — **PASS**, 19/19.
- `npm --prefix frontend-enterprise test -- src/pages/channels/WechatKfSetup.test.tsx src/pages/ChannelsPage.test.tsx src/pages/channels/channels.i18n.test.tsx src/pages/channelPresentation.test.ts src/api/client.test.ts` — **PASS**, 60/60.
- `npm --prefix frontend-enterprise run i18n:check` — **PASS**, 4,418 messages; backend contract and pseudo locale current.
- `npm --prefix frontend-enterprise run config:check` — **PASS**.
- `npm --prefix frontend-enterprise run build` — **PASS**; existing Vite large-chunk advisory only.
- Exact WeChat KF + existing WeCom/Feishu metadata regressions — **PASS**, 3/3.
- `git diff --check` and targeted Secret/storage/log/source searches — **PASS**.

### Security, evidence, and remaining risk

- The `work.weixin.qq.com` allowlist is based on committed Task 2 API/data-plane fixtures (`backend/tests/test_wechat_kf_api.py` and `backend/tests/test_wechat_kf_data_plane.py`). Whether every real provider contact-way response uses this host remains **UNVERIFIED**; no additional host was guessed or admitted.
- Real browser file-picker, clipboard, responsive layout, link navigation, and QR rendering remain **UNVERIFIED**; evidence is jsdom plus the production TypeScript/Vite build.
- Real provider credentials, account mutations, avatar upload, callback delivery, and contact-way generation remain **UNVERIFIED** and were not attempted.
- No Task 4 stream/handoff, Task 5 merge, remote operation, production action, or real-provider request was performed.
