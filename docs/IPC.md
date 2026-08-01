# IPC

**`packages/shared-types/src/ipc.ts` is the authoritative channel list.** Every channel
declares a zod request and response schema there; this file explains the shape and how to add
one, rather than restating signatures that would drift.

## Shape

The preload exposes exactly two functions. Nothing else crosses the boundary.

```ts
invoke<C>(channel: C, request: Request<C>): Promise<IpcResult<Response<C>>>
subscribe(topic, handler): () => void
```

`invoke` always resolves — it never rejects. Failures come back as an envelope:

```ts
type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { code, message } }
```

Callers must unwrap. In an E2E spec, `rr.invoke` returns the raw envelope inside
`page.evaluate`.

Errors carry a machine-readable `code`; messages are for humans and must not leak filesystem
paths to the renderer. A failed Zotero item's raw error text is deliberately kept out of the
import response for that reason.

## Rules

- All `ipcMain.handle` calls live in `main/router.ts`. The verifier fails the build if one
  appears anywhere else.
- **`wr:drop` is the one channel not in the contract, and that is the point.** A file dropped
  on a notebook's page, on the library, or on a day's blocks is read in the preload, which is the
  only place that can turn a `File` into a path, and sent on a channel the bridge does not
  expose. The renderer can `invoke` any channel in `IPC_CHANNELS`, so one taking a path would
  let it name any file on the disk and read the bytes back over `rrfile://`. It is still
  registered and zod-validated in the router. Where a drop lands is read off a `data-wr-drop-*`
  attribute in the preload's own world; the page never sends a target either.
- A dropped picture is written into the day's markdown **in the main process** (`P04`). The
  document is held there, so appending the `rrfile://` reference there means the renderer is
  never handed anything it could have turned into a path.
- Requests are validated before dispatch. Responses are validated on the way out too, outside
  production.
- The renderer never receives a filesystem path. File bytes come over `rrfile://`.

## Adding a channel

1. Declare request and response schemas in `shared-types/src/ipc.ts`.
2. Implement the handler in `main/handlers/`, taking the parsed request.
3. Register it in the router's table.
4. Test through the router, not by calling the handler directly — the validation is the part
   worth testing.

Prefer a narrow schema over `z.unknown()`. Five fields currently use it (see
`docs/SECURITY.md` gaps); don't add a sixth without a reason.
