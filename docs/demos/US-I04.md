# Contact autocomplete in Compose

*2026-08-01T20:01:27Z by Showboat 0.6.1*
<!-- showboat-id: 4a5b6aba-51b1-4e83-9ba7-f7deed291074 -->

## What this story adds: nothing, and that is the finding

US-I04 asks that typing in Compose's To/Cc field suggest existing contacts by name or email substring, and that picking one fill the field with that contact's email. **Every one of those criteria was already met before this branch**, by code two stories apart:

- **US-H01** built `RecipientField.svelte` — a hand-rolled ARIA combobox over one plain comma-separated `<input>` — and the pure `suggestContacts` / `activeEntry` / `replaceActiveEntry` in `src/lib/compose/addresses.ts` that drive it. The same component is mounted for **both** To and Cc, so Cc autocompletes because it is literally the same field.
- **`listContactsForSuggestions`** (`src/lib/server/db/contacts.ts`) has been feeding it the contact list from the compose `load` since the same story.
- **US-I01–I03** are what made that list worth having: a contacts table the owner can see, rename, and add to by hand.

So this branch adds no source. Marking the story `passes: true` on the strength of "the code looks right" would be the failure mode the Ralph loop exists to prevent, so what follows is the story's acceptance criteria driven against a real browser and a real database.

The one thing worth recording for a future story: **FR-3's "without a full page navigation" is satisfied by shape, not by a fetch.** The contacts are delivered once in the page `load` and every keystroke filters them client-side in `suggestContacts` — there is no per-keystroke endpoint, and the URL never changes. That is the right trade at this app's scale (one owner, contacts numbering in the hundreds at most), but it means **a contact added in another tab is not in this tab's popup until the compose page is reloaded**. If contacts ever outgrow one payload, that is the assumption to revisit.

## Quality checks

`svelte-check` prints a run timestamp on every line, so the capture below strips it — otherwise `showboat verify` fails on a re-run over a number that was never part of the result.

```bash
npm run check 2>&1 | grep -o "COMPLETED.*"
npm run lint 2>&1 | tail -2
```

```output
COMPLETED 1533 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
Checking formatting...
All matched files use Prettier code style!
```

## The matching rule, without a browser

`suggestContacts` and the caret helpers around it are pure, which is what lets the field's logic be asserted directly. `verify-compose-addresses.mts` is this area's script (the one-script-per-area rule); its autocomplete section is what US-I04 rests on — substring matching over **both** name and email, the rank order, the exclusion of addresses the field already holds, and `replaceActiveEntry` shedding the separator at the entry's end (picking a contact mid-list otherwise left an empty `, ,` behind — a real bug this script caught).

```bash
npx tsx src/lib/compose/verify-compose-addresses.mts 2>&1 | sed -n "/^suggestContacts/,/^[a-zA-Z]/p" | sed "\$d"
npx tsx src/lib/compose/verify-compose-addresses.mts 2>&1 | tail -1
```

```output
suggestContacts
  ok   an empty fragment suggests nothing
  ok   address prefix outranks a mid-string name hit
  ok   a name-only match is still found
  ok   matching is case-insensitive
  ok   addresses already in the field are not re-offered
  ok   the suggestion list is capped
102/102 checks passed
```

## In the browser

Self-contained, the same shape as US-I01–I03's: seed the shared demo fixture (`casey@f03-demo.example` "Casey Demo", `dana@f03-demo.example` "Dana Casey", `luca@f03-demo.example" with no name), start a dev server, log in through the real endpoint (the session cookie is `httpOnly`, so `document.cookie` cannot fake it), drive the real compose form, then tear it all down.

Two determinism notes, both learned the hard way on the dry run. The suggestion listings are **filtered to the fixture's own domain** and the picked option is addressed **by its text rather than its position**: the live database also holds real correspondents, and the first draft of this demo captured one of them because it happened to match `casey`. That would have failed `showboat verify` months later over a contact that arrived by mail, which is exactly the kind of false alarm `CLAUDE.md` warns about. The rank *order* survives the filter, so nothing being proved was weakened.

```bash
set -e
trap "kill %1 2>/dev/null; rodney --local stop >/dev/null 2>&1; node --env-file=.env node_modules/.bin/tsx src/lib/server/db/seed-f03-demo.mts --cleanup >/dev/null 2>&1" EXIT

node --env-file=.env node_modules/.bin/tsx src/lib/server/db/seed-f03-demo.mts >/dev/null
npm run dev -- --port 5183 >/dev/null 2>&1 &
until curl -sf http://localhost:5183/login >/dev/null; do sleep 1; done

rodney --local start >/dev/null
rodney --local open http://localhost:5183/login >/dev/null
rodney --local js 'fetch("/api/auth/verify-code",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({code:"123456"})}).then(r=>r.status)' >/dev/null
rodney --local open http://localhost:5183/compose >/dev/null && rodney --local waitstable >/dev/null

# Only the fixture's own contacts are asserted on. The live database also holds
# real correspondents, and whether one of them happens to match a fragment is not
# something this demo should depend on — it would fail `showboat verify` months
# later over a contact that arrived by mail. The rank *order* survives the filter.
OPTS='Array.from(document.querySelectorAll("#SLOT-suggestions [role=option]")).map(o=>o.textContent.replace(/\s+/g," ").trim()).filter(t=>t.includes("f03-demo.example")).join(" | ")'
TO_OPTS=${OPTS/SLOT/to}
CC_OPTS=${OPTS/SLOT/cc}

# The field is inert until something is typed: no popup on load.
echo "on load        -> expanded=$(rodney --local attr '#compose-form input[name=to]' aria-expanded)"

# An email-substring match. "dem" appears in no contact's *name*.
rodney --local input '#compose-form input[name=to]' 'dem' >/dev/null && rodney --local waitstable >/dev/null
echo "typed 'dem'    -> expanded=$(rodney --local attr '#compose-form input[name=to]' aria-expanded)"
echo "  suggestions  -> $(rodney --local js "$TO_OPTS")"

# A name-only match, and the ranking. "cas" is an address prefix for casey@ and
# appears only in *Dana Casey's name*, never in dana's address — so a hit that
# exists solely in the name is what puts the second row on screen at all, and
# rank (address prefix before any-substring) is what orders the two.
rodney --local input '#compose-form input[name=to]' 'cas' >/dev/null && rodney --local waitstable >/dev/null
echo "typed 'cas'    -> $(rodney --local js "$TO_OPTS")"

# Selecting one fills the field with that contact's *email*, not its name. The
# option is addressed by its text rather than by position, for the same reason
# the listings are filtered: a real contact sorting above the fixture must not
# change which row this clicks. `mousedown` is what the component listens for —
# a bare `click` after `blur` would close the popup first.
CLICK='(()=>{const o=Array.from(document.querySelectorAll("#to-suggestions [role=option]")).find(o=>o.textContent.includes("casey@f03-demo.example"));o.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));o.click();return o.id})()'
echo "picking        -> $(rodney --local js "$CLICK")"
rodney --local waitstable >/dev/null
echo "picked         -> to=[$(rodney --local js 'document.querySelector("#compose-form input[name=to]").value')] expanded=$(rodney --local attr '#compose-form input[name=to]' aria-expanded)"

# Cc gets the identical field, so it autocompletes identically.
rodney --local click '#cc-toggle' >/dev/null && rodney --local waitstable >/dev/null
rodney --local input '#compose-form input[name=cc]' 'luca' >/dev/null && rodney --local waitstable >/dev/null
echo "cc 'luca'      -> $(rodney --local js "$CC_OPTS")"
rodney --local click '#cc-suggestions-0' >/dev/null && rodney --local waitstable >/dev/null
echo "picked cc opt  -> cc=[$(rodney --local js 'document.querySelector("#compose-form input[name=cc]").value')]"

# The suggestions target the entry under the caret, not the whole field value,
# and an address already committed elsewhere in the field is not re-offered.
rodney --local input '#compose-form input[name=to]' 'casey@caseynazelrod.com, dana' >/dev/null && rodney --local waitstable >/dev/null
echo "2nd entry      -> $(rodney --local js "$TO_OPTS")"
rodney --local input '#compose-form input[name=to]' 'dana@f03-demo.example, dana' >/dev/null && rodney --local waitstable >/dev/null
echo "already used   -> [$(rodney --local js "$TO_OPTS")]"

# No navigation happened for any of it (FR-3: inline query).
echo "url throughout -> $(rodney --local url | sed 's|http://localhost:5183||')"
```

```output
on load        -> expanded=false
typed 'dem'    -> expanded=true
  suggestions  -> casey@f03-demo.example Casey Demo | dana@f03-demo.example Dana Casey | luca@f03-demo.example
typed 'cas'    -> casey@f03-demo.example Casey Demo | dana@f03-demo.example Dana Casey
picking        -> to-suggestions-0
picked         -> to=[casey@f03-demo.example, ] expanded=false
cc 'luca'      -> luca@f03-demo.example
picked cc opt  -> cc=[luca@f03-demo.example, ]
2nd entry      -> dana@f03-demo.example Dana Casey
already used   -> []
url throughout -> /compose
```

Reading that against the story's criteria:

- **"queries `contacts` by name/email substring match"** — `dem` matches all three fixture contacts on their *address*; `cas` puts `dana@f03-demo.example` on screen even though `cas` appears nowhere in that address, only in the name **Dana Casey**. Both halves of the match are exercised, and the order (`casey@` first) is the rank rule: an address prefix outranks a mid-string name hit.
- **"selecting a suggestion fills the field with that contact's email"** — picking Casey Demo writes `casey@f03-demo.example`, not the display name, and closes the popup.
- **To *and* Cc** — the Cc field, revealed by `+ Cc`, suggests and fills identically. It is the same component.
- **Inline, no navigation** (FR-3) — the URL is `/compose` throughout.

The last two lines cover the part that makes this usable on a real multi-recipient message rather than only on an empty field: suggestions target **the entry under the caret**, so typing a second address after a committed one still suggests (`dana` matches while `casey@caseynazelrod.com, ` sits to its left), and an address the field **already holds** is not offered again — re-offering it could only produce a duplicate that `parseAddressList` would then drop.
