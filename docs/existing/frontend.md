# Frontend reference

## Structure

The web workspace is a single-page React 19 application built with Vite. It
does not use a router, state-management library, component library, Markdown
renderer, or test framework. Nearly all behavior and markup lives in
`apps/web/src/App.tsx`.

| File | Responsibility |
| --- | --- |
| `index.html` | HTML shell with the `#root` mount node. |
| `src/main.tsx` | React `createRoot` entry point, Strict Mode, CSS import. |
| `src/App.tsx` | State, data loading, polling, forms, and all screens/components. |
| `src/api.ts` | Fetch wrapper, bearer token, and baseline endpoint methods. |
| `src/types.ts` | Browser copies of server response types. |
| `src/styles.css` | Complete visual system and responsive layout. |
| `vite.config.ts` | React plugin, port 5173, and `/api` development proxy. |

The server and web types are duplicated rather than shared through a package or
generated client. Any API model change must currently be updated in both
`apps/server/src/types.ts` and `apps/web/src/types.ts`.

## Application state

`App` holds:

- Agent list and selected Agent ID;
- selected Agent messages and latest Run;
- runtime/system information;
- create/settings modal visibility and the shared form model;
- prompt text, mutation busy state, and global error text;
- authentication-required state and token input.

Refs prevent stale asynchronous work from updating the wrong selection:

- `selectedIdRef` mirrors the selected ID for fetch/poll completion checks.
- `mountedRef` stops work from updating an unmounted app.
- `pollingRunIds` prevents duplicate polling loops for one Run.
- `messageEnd` supports automatic scrolling.

## Screen behavior

### Connection screen

Until `/api/auth` resolves, the app shows “Connecting to the control plane.” If
that request fails, the same screen shows an error but offers no built-in retry
button; a refresh retries bootstrap.

### Unlock screen

When the server reports authentication is required, the user enters the shared
token. The token is installed in `api.ts`, then Agent and system requests run in
parallel. A 401 is translated to “The access token is not valid.”

### Main shell

The sidebar displays Agent count/list and runtime/model details. Selecting an
Agent loads messages and Runs in parallel. The newest Run is treated as the
active/latest Run. If it is queued or running, polling resumes, which supports
browser refresh during an active server-side Run.

The main area shows:

- a configuration banner when Ark or Codex/runtime availability is missing;
- dismissible global errors;
- Agent identity and status;
- settings/start-stop/delete controls;
- message history and Run state;
- starter prompts and a prompt composer.

### Create and edit

Create uses a modal and a default instruction string. On success it refreshes
the Agent list, selects the created Agent, closes the modal, and resets the
form. Settings reuses the same form object, is disabled while the Agent is busy,
and displays the server-side workspace path.

### Start, stop, and delete

The single lifecycle button starts a stopped Agent and stops any other status.
Delete requires `window.confirm` and is disabled while busy. Stop is allowed
while busy and waits for the API call, which in turn waits for runner
cancellation.

### Prompt submission and polling

Enter submits; Shift+Enter inserts a newline. Submission is disabled for a
stopped/busy Agent or while the latest Run is queued/running. The UI optimistically:

1. appends the returned user Message;
2. sets the returned queued Run as active;
3. marks the selected Agent busy locally;
4. polls `GET /api/runs/{id}` about every 900 ms.

After a terminal status it refreshes messages and Agents. A failed Run is shown
inline. A cancelled Run has no dedicated inline card; its effect appears
through refreshed lifecycle state. Run usage is typed but not displayed.

## API wrapper behavior

`request<T>()` uses relative URLs so the same client works through Vite proxy or
production Fastify. It adds JSON content type only when a body exists and adds
the bearer header when the module-scoped token is non-empty. It expects JSON
but tolerates an empty/non-JSON response by using `{}`.

The error parser expects `error` to be a string. Coordination routes return an
error object, so extending this client to coordination must also extend error
normalization or it may construct an `ApiError` with a non-string message at
runtime.

## Styling and responsive behavior

`styles.css` defines a dark-sidebar/light-workspace layout, shared button/form
styles, lifecycle colors, message cards, modal, spinners, and animations.

- Above 900 px: fixed 290 px sidebar and full main content.
- At 900 px and below: the shell becomes a single column, sidebar becomes a
  top region, Agent list is horizontal, and content heights are adjusted.
- At 680 px and below: headers/actions/forms stack, padding shrinks, and modal
  and playground spacing are reduced.

When adding a new major feature, extracting `App.tsx` into feature components
and extracting shared API/server types will reduce merge conflicts. The
existing app is small enough that this is an extension decision, not required
baseline cleanup.

## User-visible expected states

| Condition | Visible result |
| --- | --- |
| No Agents | Empty-state call to create the first Agent. |
| Ark not configured | Runtime configuration banner naming required variables. |
| Runner unavailable | Banner recommends rebuilding POC or installing Codex. |
| New Agent | Starter prompt cards and “New session.” |
| Existing thread | “Session connected.” |
| Run queued/running | Assistant thinking card and disabled composer. |
| Run failed | Inline Run failure card with server error. |
| Agent stopped | Composer disabled with start instruction. |
| API/mutation error | Dismissible global error banner. |
