# Share to phone, and the phone as a tablet

> The live share server, the browser port as the phone client, and the transport.

> Split out of `CLAUDE.md`, which is the starting point and links here.
>
> **This is not a changelog, and it must not become one.** Keep only what is
> TRUE NOW and can be broken by accident: an invariant, a constraint the
> platform imposes, a trap. When behaviour changes, REPLACE the old text —
> never append the new alongside it. Delete anything that has stopped being
> load-bearing.
>
> The *why* — what was tried, what was measured, what was rejected — belongs
> in `ideas.csv`, one row per feature. Link to the row instead of retelling
> it here. Present tense about how it behaves, not past tense about how it
> got here.

- **Share to phone (☰ menu, `_share_btn`) covers both VIEWING and DRAWING
  now (row 182), unified into one button/dialog/address-selection rather
  than a second feature.** The dialog's Sharing/Writing toggle (a two-way
  exclusive `Gtk.ToggleButton` pair, `_show_share_ready`) sets
  `_ShareServer.drawing_allowed`; whichever address tier is in use — LAN,
  Tailscale, or the PUBLIC link via Tailscale Funnel — carries write access
  too whenever Writing is on. **This was a deliberate reversal, made
  explicitly by the user, of an earlier safety-motivated design** (a
  separate `_DrawServer` class that only ever offered LAN/Tailscale,
  specifically so a document-mutating feature could never default to a
  public link): one unified control was preferred over that split, with the
  consequence — a leaked or overheard public link can draw on the document,
  not just watch it, while Writing is picked — stated plainly and accepted
  rather than designed around. There is no drawing-only address tier that
  stays private while viewing goes public. Sharing (view-only) is the
  default every session.
  Live status is a CONTENT change on `_share_btn` itself
  (`_update_share_indicator`) — it grows a pulsing "● Live" rather than the
  button merely tinting colour (its earlier `.success`-class-only design),
  asked for explicitly as something that reads as its own status. The dot's
  opacity swing (`_pulse_share_dot`, 1.0/0.25) matches the phone page's own
  `#dot` CSS keyframes, ported to a `GLib.timeout_add` since GTK's CSS gives
  us no keyframes here.
  Works in BOTH document modes (`PDFCanvas.remote_stroke_*`/
  `remote_erase_*` and `TextPageView`'s twins, `_on_share_to_phone`'s guard
  generalized off its old PDF-only `canvas.document is None` check) — this
  app's "both modes, always" rule; a text-first page's phone mirror is
  `TextPageView.render_snapshot_png` (a flat composited-overlay snapshot,
  not `_write_text_pdf`'s vector-ink re-draw — plenty for a mobile preview,
  not worth the print-quality cost here), a PDF's is the existing
  `_render_share_page`, and both are gated by the SAME `_share_revision`
  counter Share already bumps on any document change.
  A touch always DRAWS (or erases, via the phone page's own Pen/Eraser
  toggle) with the CURRENT pen, regardless of what tool the desktop's own
  left button is bound to right now (which defaults to the CARET on the text
  sheet) — `remote_stroke_end`/`_commit_stroke` read the canvas's/sheet's
  ordinary pen-attribute accessors unchanged, so this is true for free rather
  than needing a special case. `_process_remote_touch` is the one place the
  "how many fingers, what do they mean" rule lives — pure and GTK-free by
  design, so it needs no browser, server or window to test: one finger is a
  stroke, a second joining ABORTS it (mirrors this app's own local-touch rule
  that two fingers are reserved for navigation, never a second stroke), and
  the whole episode stays blocked until every finger has lifted — a survivor
  after a partial lift does not quietly resume drawing, the same reasoning
  TouchLatch documents for local touch; touch coordinates map back through
  `providers["map_point"]`, read live off `canvas.page_width` so a page-size
  change can never desync the render and the mapping.
  - **THE PHONE RUNS THE REAL BROWSER PORT, and the QR goes straight to it.**
    `/<token>/` 302-redirects to `app/?live=1`; `_ShareServer` serves `web/`
    itself under the token path (gzip + ETag, traversal-guarded, HTTP/1.1 so
    31 requests are one connection). So the phone renders the page properly,
    holds a **camera of its own**, and draws with the real pen pipeline.
    `_SHARE_VIEWER_HTML` is now the FALLBACK, and both cases it covers are
    real: a **text-first page** (the port has no text mode) and an installed
    copy with no `web/`. `web/` is packaged by `install.sh` and both
    PKGBUILDs — it never was, and this made it load-bearing.
    - **Same origin is not a preference, it is the only thing that works.**
      The hosted GitHub Pages copy cannot reach a desktop privately: mixed
      content AND Chrome's Local Network Access block it, LNA counts the
      tailnet as local, and **TLS does not lift LNA** (measured with a real
      cert and permissive CORS). A LAN address can never satisfy mixed
      content at all — no CA issues a cert for `192.168.x.x`. Only the public
      Funnel tier could have worked, which would have made the public link
      the *only* transport. Numbers in `notes/phone-web-port-sync-plan.md`;
      don't re-derive them, and don't "just host it on Pages".
      **Installing the hosted copy does not change this** — an installed page
      has the same origin and the same per-request checks as a tab, and neither
      does serving structured JSON instead of HTML, since the block is on the
      request and not on the payload. The ONE thing that could change is
      whether Chrome now offers a *permission prompt* for local network access;
      `web/lna-probe.html` settles that from the phone, and until it does, the
      hosted app is a launcher (`web/CLAUDE.md`), never a client.
    - **`live.pdf` is `save_copy`, NEVER the `pdf` provider.** That one is the
      Download button's baked export with notes flattened onto the pages; the
      port adopts real annotations into editable strokes, so the baked one
      arrives as a picture of ink nothing can erase or undo.
    - **Pages arrive ONE AT A TIME** (`page.pdf?n=N`, `Doc.attachLazyPages`),
      sliced from the same per-revision copy. 60-page deck: 535.8 KB → 9.2 KB
      to first paint. Trap met on the way: `strokesFor()` CREATES the page's
      array on first access, so a "does this page have ink yet" test must ask
      whether it is EMPTY, not whether the key exists.
  - **The transport is a WebSocket (`_WSConn`), hand-rolled on the stdlib.**
    Three details are load-bearing because each fails silently: client frames
    are always MASKED, the payload length has THREE encodings (fine until a
    stroke crosses 126 bytes), and a message may arrive fragmented.
    **Each connection has its own SENDER THREAD with frame coalescing** — the
    desktop's live stroke is pushed from the motion handler on the GTK main
    thread, and a socket write to a phone out of wifi would freeze the app
    under the hand that is drawing. Nothing user-facing touches the socket.
  - **Both directions are live, and the wire carries DOCUMENT coordinates.**
    The phone streams raw samples (it knows the real page geometry, so
    `map_point` is identity) — which is what lets it draw under a zoom the
    desktop knows nothing about, and is how row 182's deferred camera stopped
    being a feature and became a consequence. The desktop mirrors its own
    in-progress stroke back, painted on the phone on top of the cached layer.
    On commit the desktop pushes **that page's strokes as JSON**, never the
    whole PDF (re-serialising is ~500 ms plus a re-parse, per stroke). The
    delta **REPLACES rather than merges** and needs no reconciliation: the
    desktop's list is the whole truth for a page, ink the phone drew
    included. A structural change is the exception, detected from the page
    count and answered with a full reload. Every push **skips the connection
    that caused it** (`ink_origin`), or drawing reloads the document under
    the hand that drew.
  - **A gesture that never closes wedges drawing FOR EVER, and it did.**
    `_process_remote_touch`'s two-finger rule latches `blocked` while a
    pointer id sits in `active`, and the port nulls `active` in several places
    OUTSIDE `_onUp` (a circle becoming a lasso, a second finger starting a
    pinch) — so the close never fired and phone→laptop ink died until reload.
    Fixed on BOTH sides deliberately: the client closes from a catch-all in
    `_onUp`, and the server treats a NEW gesture id as implicitly ending the
    old one. A transport must not be one client bug away from wedging itself.
  - **The phone reports its viewport** and the canvas draws it as a dashed
    rectangle (`set_remote_view` / `_draw_remote_view`), suppressed when it
    covers essentially the whole page — a rectangle around everything says
    nothing. Cleared when the connection drops.
  - **The mobile layout is a body class** (`MOBILE` = `pointer: coarse` and
    `hover: none`, so a laptop with a touchscreen is not one): binding
    stripes hidden (one finger, one answer, so the readout is a column of
    identical colours), sidebar and notes collapsed, presenter and Download
    in the ☰. Open/Save are hidden in a shared session on **any** device — a
    laptop that scans the link is just as much a guest. In landscape the
    toolbar becomes a **rail down the left** so the page keeps the height;
    `--header-h` is overridden there, and everything floating under the
    header (the ☰ popover, the rail itself) measures from it — the bug that
    taught this was the menu opening 50px low, anchored to a two-row header
    that no longer existed.
  - **Write-and-advance** (☰ *Advance while writing*, row 187, off by
    default): finish a stroke near the right edge, pause, and the view moves
    along; at the page edge it wraps to the next line, spaced by the size of
    what you have actually been writing. A new press cancels it — you had not
    finished after all. Purely a camera move, so it cannot displace a stroke
    or desync a session. Deliberately **no character segmentation**: "have
    you run out of room?" is answered exactly by where a stroke ended, while
    "was that a letter?" is not answered by a pen lift at all (row 184).
  - **The phone-view tool points the phone at something** (Ctrl+Shift+left,
    PDF only). Draw a region and it goes there; grab the dashed rectangle and
    drag it and the phone follows LIVE. **There is ONE box** — the indicator
    that already says where the phone is — so the tool writes to the same
    state the phone does and neither owns it: after a move the box is where
    the phone is *because that is where it went*, and the phone stays free to
    pinch away, at which point its own reports drive the box again. No
    separate lifetime, no lock, no second rectangle. A CLICK sends it back to
    the whole page (zoom-to-region's escape), and a whole-page box paints
    nothing. Three things it must keep doing: the button is in the bar only
    while a share is live (`_sync_phone_tool_chrome`, **and hidden at
    construction** — a GTK widget is visible by default and
    `_update_header_for_mode` may not run before the window is shown); the
    chord is INERT with no share, but stays in the table, because a binding
    that vanished when you stopped sharing is the second mapping row 132
    forbids; and the phone's reports are ignored *while the box is dragged
    here*, since they are a round trip behind and the box would stutter
    between the hand and the phone.
  - **The share dialog was slow for two reasons and the big one was not the
    obvious one** (row 186). `HTTPServer.server_bind` calls `socket.getfqdn()`
    to fill in `server_name` — on a `0.0.0.0` bind that is a reverse lookup
    with nowhere to go, **measured at 5004 ms every time the dialog opened**,
    for a value this server never emits. Overridden away. The Funnel was the
    other half (seconds, 25 s ceiling) and is now provisioned in the
    background with the QR already scannable — `_share_prepare` went 5059 ms →
    24 ms. **The arriving public link must not take the dropdown**: it would
    be "the best entry with a url" and swap the QR under you mid-scan, which
    with Writing as the default widens who can draw on your document.
  - **A share must be torn down on EVERY exit that can be.** A Funnel mapping
    lives in `tailscaled`, not in us, so once the process is gone nothing
    knows to remove it and a public hostname points at a dead port. Ctrl+C
    leaked one for a long time: `_on_sigint` called `win.destroy()`, which
    deliberately skips close-request (no save prompt to block on) — and
    close-request was the ONLY path reaching `_stop_sharing`. It goes through
    `_destroy_all` now, SIGTERM is wired to the same handler, and
    `_live_funnels` + `atexit` are the last resort. Nothing covers SIGKILL.
  - **The ADDRESS is stable and bookmarkable, and the public one is not**
    (row 189). A preferred port (`SHARE_PREFERRED_PORT`, 8756, falling back to
    a random one) plus a token persisted in settings.json, so a home-screen
    shortcut keeps working; renameable, and rollable to revoke every saved
    copy. **Two secrets, not one**: the permanent token is what makes the
    address bookmarkable and exactly what must not travel over the PUBLIC
    tier, where it leaks in ways a per-session one cannot (history, a photo of
    the QR, a screen share) and stays valid until someone rotates it. The
    private tiers keep the bookmarkable one; the public link gets its own,
    fresh each session and never saved. A stale link says so instead of a bare
    404 — for a NAVIGATION only, since a stray HTML body in place of a script
    is worse than an honest error.
  - **The INSTALLABLE address is a fourth tier, `tailscale serve` on :8443**
    (row 190). Every other tier is plain HTTP, and a browser will only install
    an app — or run a service worker — on a secure origin, so none of them can
    be more than a bookmark on a phone. `tailscale serve --bg --https=8443`
    puts a real Let's Encrypt certificate on the node's own `*.ts.net` name
    with **nothing published**, which is the only private HTTPS address this
    machine has.
    - **8443 AND NOT 443, and this is the load-bearing part.** 443 is Funnel's
      front, and `_tailscale_funnel_stop` is NODE-WIDE (`--https=443 off` is
      the only spelling the current CLI takes). Sharing the port would mean a
      share ending silently drops the other mapping, with nothing to tell the
      two apart — the failure the funnel's own teardown already has to reason
      about. Tailscale accepts 443, 8443 and 10000 for HTTPS; taking one of the
      others means the two never touch, and `_tailscale_serve_stop` can be the
      simple thing the funnel's stop cannot be.
    - **Provisioned in the background and starting `pending`**, exactly like
      the funnel and for the same reason: a certificate takes seconds, and a
      tier that arrives late must never take the tab under a scan. It is LAST
      in `_share_prepare`'s list, which is the dialog's preference order.
    - **It carries the PERMANENT token, deliberately unlike the public link.**
      An installed icon whose `start_url` expired at the end of the session is
      an icon that opens a 404. This address never leaves the tailnet, which is
      exactly why it may carry the bookmarkable secret.
    - **The manifest under the token path is GENERATED** (`app_manifest`), not
      the port's own file: `start_url` is `./?live=1` (without the flag the
      icon opens the app in its ORDINARY mode on this origin — no session to
      restore and no file to open, a blank page that reads as a broken share),
      the name carries this machine's hostname so two computers are two icons
      you can tell apart, `id` carries the token so the second install does not
      replace the first, and `share_target`/`file_handlers` are dropped for the
      same reason Open and Save are hidden here. Everything else comes from
      `web/manifest.webmanifest`, so the two cannot drift.
    - The phone's own list of computers, and why it navigates rather than
      connecting, is `web/CLAUDE.md`.
  - **A random port is unfirewallable BY CONSTRUCTION**, and that was the real
    cause of "the phone never loads": ufw with a DROP default has nothing to
    allow when the port changes every session. Hence the stable port, and the
    Same Wi-Fi entry naming the exact `ufw allow` when a firewall is running —
    the failure is otherwise silent from inside the app, because the
    connection never arrives.
  - **ONE PHONE DRAWS AT A TIME**, and a viewport box PER phone. The canvas
    has a single `current_stroke`, so two phones interleaved into one
    corrupted line. Dragging one box moves that phone; drawing a region points
    them all. **The grab and the painter read ONE list**
    (`visible_remote_rects`): a phone on the whole page has a box covering it
    that is deliberately not drawn, and while the grab had its own hit test
    that invisible box swallowed every press.
  - **The phone's tool is SHARED STATE with the desktop** (opt-in, remembered
    — "Link the phone's tool to this computer"). One system reached from two
    places, not two apps with their own pens:
    - It is the **FINGER binding**. Picking a tool on the phone binds the
      finger here (`_set_finger_tool`), so the desktop's own bar moves with
      it — which is what picking a tool on a touchscreen already means, since
      the toolbar is a binding surface and a finger is a button (row 132).
      Picking one here pushes it there (`_push_share_tool`).
    - **A modifier held on this keyboard runs that chord's tool on the
      phone.** Resolved on the DESKTOP, because a copy of the table on the
      phone is the second mapping row 132 forbids; the phone is sent the
      answer, never the table.
    - The push carries `tool` (what a touch does right now, modifiers
      included) and `base` (the finger's own binding). The phone STORES the
      base and only displays `tool`, so releasing a key needs no message.
    - *ceiling: only pen, highlighter and eraser have remote verbs. A chord
      bound to lasso, pan or zoom is ignored rather than half honoured —
      which is also what keeps a touch drawing when `finger` is bound to
      something unreachable.*
  - **A browser that dies leaves a record.** The server logs every request
    with its user agent, independent of the phone's JS — a browser that dies
    before running a line of ours still made requests. Breadcrumbs go to
    `/diag` by keepalive FETCH, never `sendBeacon`, which Brave neutralises by
    returning true and discarding. Routine ones are INFO; only errors warn.
  - **The Funnel teardown is NODE-WIDE** (`--https=443 off` is the only
    spelling the current CLI takes), so a late teardown from an abandoned
    share used to kill a newer share's funnel — same port, nothing to tell
    them apart. It only stops when nothing has replaced it, and every stop
    logs its caller. *ceiling: Tailscale's public ingress currently accepts
    the TCP connection and closes during TLS, with nothing reaching
    tailscaled, while the tailnet path works — verified against all three
    ingress IPs with the funnel confirmed on. That is theirs, not ours (row
    186); don't look for it here.*
  DEFERRED, tracked in ideas.csv row 182: multiple phones drawing at once, a
  long-press tool picker beyond the plain Pen/Eraser toggle, and a
  character-by-character "typewriter" input mode (row 184).
