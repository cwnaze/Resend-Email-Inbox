# US-G02: Sanitized HTML rendering with image opt-in

*2026-07-28T19:09:17Z by Showboat 0.6.1*
<!-- showboat-id: 9fe53fdb-25ae-42aa-8099-20867dcb4969 -->

**US-G02 — Sanitized HTML rendering with image opt-in.** An HTML email body now renders inside a sandboxed `<iframe srcdoc>` (`sandbox="allow-same-origin"`, never `allow-scripts`) sized to its content height. Every remote `<img src>` is moved aside on the server before the markup crosses the wire, so nothing in a stored body reaches a third party on open; a per-message **Load images** button puts them back for that one message. A message with only `body_text` renders as preformatted, wrapped plain text and mounts no iframe at all.

What this story adds:

- `src/lib/inbox/srcdoc.ts` — pure (no env/db/DOM/deps), shared by the load, the component and the verification script: `BLOCKED_IMAGE_ATTR`, `restoreBlockedImages`, `buildEmailSrcdoc`.
- `src/lib/server/inbox/html.ts` — `prepareEmailHtml`, the read-path pass that re-sanitizes a stored body and parks each remote image URL on `data-dt-blocked-src`, returning the blocked count.
- `src/routes/(app)/inbox/[threadId]/EmailHtmlBody.svelte` — the sandboxed frame, the toggle, content-height measurement, and link-click interception.
- `hasVisibleContent` on `prepareEmailHtml`'s result — the body-choice decision, made in the DOM — and `SANITIZE_OPTIONS` exported from `src/lib/server/inbound/sanitize.ts` so the write path and this read path cannot sanitize under different rules.

Decisions worth keeping:

- **Blocking is a read-path decision, not a write-path one.** `emails.body_html` still holds the sender's image URLs — "Load images" has to be able to put them back — and FR-3 asks for an opt-in *per message*, which a stored-once-stripped body could not offer.
- **The image URL is parked on a `data-*` attribute** precisely because the sanitizer runs with `ALLOW_DATA_ATTR: false`. A sender who writes `data-dt-blocked-src` themselves has it stripped before ours is added, so the only values that can ever be restored are the ones we moved. A `javascript:` src is likewise gone before this pass sees the element, so parking can never restore a scheme DOMPurify refused.
- **The toggle is enforced twice**: the attribute swap, and the srcdoc's own CSP (`default-src 'none'`, `img-src data:` until the reader opts in). `data:` and `cid:` sources are never counted as blocked — a data URI is bytes already in the body, and a `cid:` reference reaches nobody.
- **No DOMPurify hooks.** The blocking pass walks the sanitized DOM fragment instead. Hooks live on the process-wide DOMPurify singleton and `removeHook` pops whichever hook is last rather than a named one, so a second hook registered anywhere in the process could have left this closure installed on the *write* path — quietly writing `data-dt-blocked-src` into stored bodies. Walking a fragment has no global state to get wrong.

Three things the sandbox does **not** give you for free. All three were found by review or by driving the real browser, and each is fixed here:

- **A sandbox without `allow-popups` does not make links inert.** A plain `<a href>` navigates the frame *itself*, which sandbox always permits — so a phishing link rendered the attacker's page inside this app's chrome, and the frame went cross-origin, silently killing the height measurement with it. The fix is declarative: the srcdoc carries `<base target="_blank">`, and opening a new context is exactly what the sandbox blocks, so the worst case is "nothing happens" even with no JS. The component's click handler is an upgrade on top, turning that into a real new tab.
- **`documentElement.scrollHeight` is floored at the frame's own viewport height**, so measuring it returns whatever height was last set: the frame could only ever grow, never shrink, and every short message was padded out to the initial guess. The content height comes from the **body** box instead.
- **A body's last bottom margin collapses through the body**, so `body.scrollHeight` alone stopped short of the final line and clipped it. The srcdoc stylesheet sets `display: flow-root` on the body to contain that margin — load-bearing for sizing, not cosmetic.
- **A regex that skips quoted attribute values backtracks catastrophically.** One was added here to stop a sender-controlled `>` inside an attribute from ending a tag early; it turned 6ms into **15 seconds** on a body of 4000 bare `<` characters, and these helpers run for every row of the inbox list. Reverted to the naive form: the leak it fixed is cosmetic now that the body choice is made in the DOM, and a denial of service is not worth a tidier snippet.
- **`<template>` content is invisible to `querySelectorAll`** (it lives in a separate fragment), so a remote image parked inside one was neither blocked nor counted. It is forbidden on the **read** path only: doing it on the shared write path deletes the text inside the element from the only copy of the message, and AMP-for-Email bodies carry their content exactly that way.

## Quality checks

```bash
npm run check 2>&1 | grep -E "COMPLETED" | sed "s/^[0-9]* //"
```

```output
COMPLETED 1508 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
```

```bash
npm run lint 2>&1 | tail -n 2
```

```output
Checking formatting...
All matched files use Prettier code style!
```

## Pure helpers and the blocking pass

The standing standalone check (`verify-inbox-list.mts`) grew a US-G02 section rather than gaining a sibling script.

```bash
node --env-file=.env node_modules/.bin/tsx src/lib/server/db/verify-inbox-list.mts 2>&1 | sed -n "/^prepareEmailHtml/,/^listInboxThreads/p" | grep -v "^listInboxThreads"
```

```output
prepareEmailHtml
  ok   returns null for a null body
  ok   returns null for a blank body
  ok   returns null for a body that is entirely stripped
  ok   keeps prose markup
  ok   counts no blocked images when there are none
  ok   moves a remote image src onto the blocked attribute
  ok   leaves no src attribute behind
  ok   counts the blocked image
  ok   counts every blocked image
  ok   leaves a data: image loading
  ok   does not count a data: image as blocked
  ok   does not count a cid: image as blocked (nothing to load)
  ok   strips scripts
  ok   strips event handlers
  ok   strips nested iframes
  ok   a sender-supplied blocked-src attribute does not survive to be restored
  ok   drops remote media src outright
  ok   never parks a javascript: src
  ok   a meta refresh cannot survive to redirect the frame
body choice: hasVisibleText / hasDefiniteImage / blockedImageCount
  ok   prose is visible text
  ok   markup with nothing in it is not
  ok   an image-only body has no visible text
  ok   a style-hidden preheader still counts as visible text (style is stripped on write)
  ok   text inside a [hidden] element does not (it renders nothing)
  ok   ...but the hidden element is still rendered as written (the text test must not mutate the body)
  ok   a hero image with px dimensions is a definite image
  ok   a responsive hero sized in % is too
  ok   a 1x1 tracking pixel is not
  ok   a 600x1 spacer rule is not
  ok   a 16x16 logo is not
  ok   a 17x17 image is
  ok   a dimensionless image is not (CSS-sized trackers are the common kind)
  ok   an image whose src the sanitizer removed is not
  ok   a definite-size image inside a [hidden] subtree is not (it renders blank)
  ok   a px unit on a real size still counts
  ok   a decimal size still counts
  ok   a px unit on a pixel size is still a pixel
  ok   a non-numeric size is not evidence either way
  ok   a small number inside the parked URL cannot demote a real image
  ok   alt text mentioning width=1 cannot demote a real image
  ok   a cid: image is not counted as blocked
  ok   a data: image is not counted as blocked
  ok   a remote image is
  ok   the read path drops <template> so its content cannot hide a remote image
  ok   the write path keeps text inside a <template> rather than deleting it
buildEmailSrcdoc
  ok   is a full document
  ok   restricts img-src to data: while images are blocked
  ok   keeps the image blocked in the document body
  ok   forces every link into a new browsing context, which the sandbox then blocks
  ok   restores the src once images are loaded
  ok   opens img-src for remote schemes once images are loaded
  ok   restoreBlockedImages is a no-op on markup with nothing blocked
```

```bash
node --env-file=.env node_modules/.bin/tsx src/lib/server/db/verify-inbox-list.mts 2>&1 | grep -E "^(  FAIL|[0-9]+/[0-9]+)"
```

```output
156/156 checks passed
```

## Browser verification

The shared seeder's HTML-only message carries one remote image (blocked), one `data:` image (never blocked) and a link (for the containment check). Assumes `npm run dev` on :5173.

Each browser block below starts by closing any stray tab and selecting the app tab: a link click deliberately opens a new tab, and that tab takes focus.

```bash
node --env-file=.env node_modules/.bin/tsx src/lib/server/db/seed-f03-demo.mts
rodney --local start >/dev/null 2>&1 || true
rodney open http://localhost:5173/login >/dev/null
rodney waitstable >/dev/null
# The session cookie is httpOnly, so it has to come from the endpoint itself.
rodney js "fetch(\"/api/auth/verify-code\",{method:\"POST\",headers:{\"content-type\":\"application/json\"},body:JSON.stringify({code:\"123456\"})}).then(r=>r.status)"
```

```output
seeded
200
```

```bash
rodney open "http://localhost:5173/inbox?q=f03-demo+conversation" >/dev/null
rodney waitstable >/dev/null
rodney click "ul li a" >/dev/null
rodney waitstable >/dev/null
rodney sleep 1 >/dev/null
echo "messages rendered: $(rodney js "document.querySelectorAll(\"article\").length")"
echo "iframes (only the HTML message gets one): $(rodney js "document.querySelectorAll(\"iframe\").length")"
echo "pre blocks (only the text-only message): $(rodney js "document.querySelectorAll(\"pre\").length")"
echo "sandbox: $(rodney attr "iframe" sandbox)"
echo "allow-scripts in the sandbox list: $(rodney js "document.querySelector(\"iframe\").sandbox.contains(\"allow-scripts\")")"
echo "srcdoc CSP: $(rodney js "document.querySelector(\"iframe\").getAttribute(\"srcdoc\").match(/content=\"([^\"]*)\"/)[1]")"
echo "--- the toggle"
rodney text "article:nth-of-type(2) div div"
```

```output
messages rendered: 2
iframes (only the HTML message gets one): 1
pre blocks (only the text-only message): 1
sandbox: allow-same-origin
allow-scripts in the sandbox list: false
srcdoc CSP: default-src 'none'; img-src data:; style-src 'unsafe-inline'
--- the toggle
1 remote image blocked

Load images
```

Inside the frame, before opting in: the remote image has no `src` at all (its URL is parked, `naturalWidth` 0 — nothing was fetched), while the `data:` image loaded normally. The frame is sized to its content, and the last line is not clipped.

```bash
rodney js "JSON.stringify([...document.querySelector(\"iframe\").contentDocument.images].map(i=>({src:i.getAttribute(\"src\"),parked:i.getAttribute(\"data-dt-blocked-src\"),loadedWidth:i.naturalWidth})),null,1)"
# The measurement settles asynchronously (load + ResizeObserver), so give it a beat.
rodney sleep 2 >/dev/null
rodney js "(() => { const f=document.querySelector(\"iframe\"); const d=f.contentDocument; const last=d.body.lastElementChild.getBoundingClientRect(); return JSON.stringify({frameHeight:f.getBoundingClientRect().height, bodyContentHeight:d.body.scrollHeight, lastLineBottom:Math.round(last.bottom), lastLineClipped:last.bottom > f.getBoundingClientRect().height}); })()"
```

```output
[
 {
  "src": null,
  "parked": "https://example.com/tracker.gif",
  "loadedWidth": 0
 },
 {
  "src": "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7",
  "parked": null,
  "loadedWidth": 1
 }
]
{"frameHeight":208,"bodyContentHeight":208,"lastLineBottom":194,"lastLineClipped":false}
```

**Links cannot take the frame over.** The assertion below is the invariant that holds whether or not the click handler is attached: after clicking a link, the frame still shows the email rather than the remote page.

```bash
echo "srcdoc forces links into a new context: $(rodney js "document.querySelector(\"iframe\").getAttribute(\"srcdoc\").includes(\"<base target=\\\"_blank\\\">\")")"
rodney js "(()=>{const d=document.querySelector(\"iframe\").contentDocument; d.querySelector(\"a\").click(); return \"clicked \" + d.querySelector(\"a\").getAttribute(\"href\");})()"
rodney sleep 2 >/dev/null
# The click opens a new tab, which takes focus: re-select the app tab by URL.
APP=$(rodney pages | tr -d "*" | grep localhost | sed -E "s/.*\[([0-9]+)\].*/\1/" | head -1)
rodney page "$APP" >/dev/null
echo "frame still same-origin (never taken over): $(rodney js "document.querySelector(\"iframe\").contentDocument !== null")"
echo "frame still showing the email: $(rodney js "document.querySelector(\"iframe\").contentDocument.URL")"
```

```output
srcdoc forces links into a new context: true
clicked https://example.com/invoice
frame still same-origin (never taken over): true
frame still showing the email: about:srcdoc
```

Clicking **Load images** on that one message restores its `src`, opens the frame's own `img-src` policy, and retires the toggle. Nothing about any other message changes — there is no app-wide setting here. The frame is re-measured afterwards and *shrinks*, which is the behaviour a `documentElement.scrollHeight` measurement cannot produce.

```bash
# Drop the tab the link click opened, and reload the thread so the toggle is back
# in its default state.
for i in $(rodney pages | tr -d "*" | grep -v localhost | sed -E "s/.*\[([0-9]+)\].*/\1/"); do rodney closepage "$i" >/dev/null 2>&1 || true; done
APP=$(rodney pages | tr -d "*" | grep localhost | sed -E "s/.*\[([0-9]+)\].*/\1/" | head -1)
rodney page "$APP" >/dev/null
rodney open "http://localhost:5173/inbox?q=f03-demo+conversation" >/dev/null
rodney waitstable >/dev/null
rodney click "ul li a" >/dev/null
rodney waitstable >/dev/null
# Wait for hydration: until the frame has been measured its height is still the
# pre-measure guess, and its click handler is not attached yet.
for _ in $(seq 30); do
  H=$(rodney js "document.querySelector(\"iframe\").getBoundingClientRect().height")
  [ "$H" != "120" ] && break
  rodney sleep 0.5 >/dev/null
done
echo "--- before the toggle"
rodney js "JSON.stringify({toggleButtons:document.querySelectorAll(\"article button\").length, frameHeight:document.querySelector(\"iframe\").getBoundingClientRect().height})"
# Driven with a direct click: `rodney click` on this button waits for network idle,
# which the restored remote image request never reaches in this sandbox.
rodney js "document.querySelector(\"article:nth-of-type(2) button\").click()" >/dev/null
rodney sleep 2 >/dev/null
echo "--- after the toggle"
rodney js "JSON.stringify({csp:document.querySelector(\"iframe\").getAttribute(\"srcdoc\").match(/content=\"([^\"]*)\"/)[1], imgs:[...document.querySelector(\"iframe\").contentDocument.images].map(i=>i.getAttribute(\"src\")), toggleButtonsRemaining:document.querySelectorAll(\"article button\").length, frameHeight:document.querySelector(\"iframe\").getBoundingClientRect().height},null,1)"
echo "still sized to its content, and it shrank rather than only growing:"
rodney js "(() => { const f=document.querySelector(\"iframe\"); return f.getBoundingClientRect().height === f.contentDocument.body.scrollHeight && f.getBoundingClientRect().height < 208; })()"
```

```output
--- before the toggle
{"toggleButtons":1,"frameHeight":208}
--- after the toggle
{
 "csp": "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; upgrade-insecure-requests",
 "imgs": [
  "https://example.com/tracker.gif",
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAAAAAAALAAAAAABAAEAAAIBRAA7"
 ],
 "toggleButtonsRemaining": 0,
 "frameHeight": 204
}
still sized to its content, and it shrank rather than only growing:
true
```

### Which body a message renders

The third acceptance criterion is about a message with *only* `body_text`, but the hard cases have **both** parts, and six rounds of review turned this from an either/or into two independent decisions:

- A **frame** is mounted when there is anything to frame: real text, an image that is demonstrably not a tracking pixel, or any remote image that was blocked (the reader may want to load it, and the notice is how they learn it exists). Nothing to frame — an empty body, or one whose only image is an unresolvable `cid:` reference — leaves `html` null so the honest "no body" line renders instead of a blank frame.
- The **text part** is dropped *only* when the HTML has readable text of its own.

That second rule is the whole lesson. Earlier versions decided it from a size heuristic over the images, and every threshold was one attribute away from being bypassed — `width="4"`, then `width="17"` — with each bypass silently discarding a readable message and leaving no way to reach it. A heuristic cannot win that argument, so it no longer gets to: a frame whose content cannot be vouched for is shown *with* the text beneath it, and the reader loses nothing either way.

The image heuristic still decides whether a frame is worth mounting, and it is computed **in the DOM** inside `prepareEmailHtml` — `textContent` for text (skipping `[hidden]` subtrees, which render nothing), and for images a positive size declaration, ignoring images with no `src` and images inside hidden subtrees. Never by pattern-matching the finished markup: a sender controls both the URL and the attribute text of an `<img>`, so a regex there read `hero.png?height=2` as a 2px image, and a de-tagging regex stopping at the first `>` let a `>` in a query string masquerade as body text.

The three threads below come from one seeder: a spacer-plus-pixel body beside a readable text part, an image-only hero beside a "view in browser" stub, and a body with nothing to show at all.

```bash
node --env-file=.env node_modules/.bin/tsx src/lib/server/db/seed-g02-pixel.mts
for q in "g02-pixel+pixel" "g02-pixel+hero" "g02-pixel+nothing"; do
  rodney open "http://localhost:5173/inbox?q=$q" >/dev/null
  rodney waitstable >/dev/null
  rodney click "ul li a" >/dev/null
  rodney waitstable >/dev/null
  rodney sleep 1 >/dev/null
  echo "== $q"
  echo "   iframes mounted: $(rodney js "document.querySelectorAll(\"iframe\").length")"
  echo "   pre blocks: $(rodney js "document.querySelectorAll(\"pre\").length")"
  echo "   Load images buttons: $(rodney js "document.querySelectorAll(\"article button\").length")"
  echo "   what the reader sees: $(rodney text "article" | tail -1)"
done
```

```output
seeded pixel thread
== g02-pixel+pixel
   iframes mounted: 1
   pre blocks: 1
   Load images buttons: 1
   what the reader sees: Your code is 480912.
== g02-pixel+hero
   iframes mounted: 1
   pre blocks: 1
   Load images buttons: 1
   what the reader sees: View this email in your browser
== g02-pixel+nothing
   iframes mounted: 0
   pre blocks: 0
   Load images buttons: 0
   what the reader sees: This message has no body.
```

```bash {image}
![The thread view with the second message's HTML body in its sandboxed frame: one remote image held behind a dashed placeholder, the inline data: image rendered, and the link visible rather than clipped at the frame bottom edge.](/private/tmp/claude-501/-Users-bloodintern1-Desktop-Resend-Email-Inbox/04f39db3-4c26-412a-b51d-fdebda8a45cc/scratchpad/g02-fixed.png)
```

![The thread view with the second message's HTML body in its sandboxed frame: one remote image held behind a dashed placeholder, the inline data: image rendered, and the link visible rather than clipped at the frame bottom edge.](b80815ec-2026-07-28.png)

### Cleanup

The seeded rows and the login code go away again, so the demo leaves the live database as it found it.

```bash
node --env-file=.env node_modules/.bin/tsx src/lib/server/db/seed-g02-pixel.mts --cleanup
node --env-file=.env node_modules/.bin/tsx src/lib/server/db/seed-f03-demo.mts --cleanup
```

```output
cleaned pixel thread
cleaned up
```
