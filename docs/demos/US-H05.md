# Attach files when composing

*2026-08-01T01:45:06Z by Showboat 0.6.1*
<!-- showboat-id: 929cdaed-b0f9-4df8-b380-5fdfaed588da -->

-

```bash
npm run check 2>&1 | sed -E "s/^[0-9]+ /<ts> /" | grep -v "^> "
```

```output


<ts> START "/Users/bloodintern1/Desktop/Resend-Email-Inbox"
<ts> COMPLETED 1527 FILES 0 ERRORS 0 WARNINGS 0 FILES_WITH_PROBLEMS
```

```bash
npm run lint 2>&1 | grep -v "^> " && echo "eslint: no findings"
```

```output


Checking formatting...
All matched files use Prettier code style!
eslint: no findings
```

The pure rules — the ones the browser gates on and the send re-checks. Note what `parsePendingAttachments` refuses: a key naming an existing message's file, a duplicate key (two rows on one object would alias, the bug US-H04 avoided by copying), and a negative size.

```bash
npx tsx src/lib/compose/verify-compose-addresses.mts 2>&1 | sed -n "/^attachments (US-H05)/,$p"
```

```output
sed: 1: "/^attachments (US-H05)/,
": expected context address
```

```bash
npx tsx src/lib/compose/verify-compose-addresses.mts 2>&1 | sed -n "/^attachments (US-H05)/,\$p"
```

```output
attachments (US-H05)
  ok   a key this app minted is accepted
  ok   a key with no filename segment is still a key (a name can slug to nothing)
  ok   a stored attachment key is NOT — a send cannot be talked into mailing an existing message’s file
  ok   nor is an inbound one
  ok   nor is a traversal out of the prefix
  ok   nor is a non-uuid segment
  ok   a filename keeps its own name
  ok   a path is reduced to its last segment
  ok   control characters are stripped
  ok   a name that reduces to nothing gets a placeholder
  ok   so does a bare dot-dot
  ok   an empty field parses to nothing
  ok   so does malformed JSON, rather than throwing
  ok   so does a JSON value that is not an array
  ok   a well-formed entry survives with its name sanitized
  ok   an entry naming a key this app did not mint is dropped
  ok   the same key twice is attached once — two rows on one object would alias
  ok   a nonsense size is clamped to zero rather than poisoning the running total
  ok   the total is the sum, and the limit is exclusive of nothing below it
  ok   …and one byte over is over

99/99 checks passed
```

The server half, against the live database with R2 stubbed. The two checks that matter most: R2's size wins over the form's (and the size check runs over the HEADs *before* any download, so an oversized send costs metadata requests rather than 25 MB of transfer), and the per-message limit spans both sources.

```bash
node --env-file=.env node_modules/.bin/tsx src/lib/server/outbound/verify-outbound-send.mts 2>&1 | sed -n "/^picked attachments (US-H05)/,\$p" | grep -v "^pending attachment cleanup\|^    at "
```

```output
picked attachments (US-H05)
  ok   a pending key is namespaced by the upload id, with the name as decoration only
  ok   and the id reads back out of it
  ok   the picked file is read
  ok   its display name is the one the form supplied
  ok   its content type comes from R2, not the form
  ok   the bytes are the uploaded object
  ok   and the source id is the upload id
  ok   the loaded total is the sum of the bytes
  ok   a key the app never minted is refused before it ever reaches R2
  ok   a vanished upload throws rather than sending a message with the file silently gone
  ok   R2’s size is what the limit is enforced against — an understating form buys nothing
  ok   the limit is per message, so a forward’s files leave less room for picked ones
  ok   the picked file is recorded against the sent message
  ok   under this message’s own key, not the pending one
  ok   and the pending object is swept once it is redundant
  ok   while the message’s own copy stays
  ok   a failed sweep is swallowed — the mail is already out
  ok   the thread appears in the inbox list
  ok   its preview is the newest message
67/67 checks passed
```

-

```bash
ACCOUNT=$(grep -m1 "^R2_ACCOUNT_ID=" .env | cut -d= -f2); BUCKET=$(grep -m1 "^R2_BUCKET_NAME=" .env | cut -d= -f2); curl -s -X OPTIONS "https://$ACCOUNT.r2.cloudflarestorage.com/$BUCKET/outbound/pending/probe" -H "Origin: http://localhost:5173" -H "Access-Control-Request-Method: PUT" -H "Access-Control-Request-Headers: content-type" -D - -o /dev/null | grep -i "^HTTP\|^access-control" | tr -d "\r"
```

```output
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: http://localhost:5173
Access-Control-Allow-Headers: content-type
Access-Control-Allow-Methods: PUT
Access-Control-Max-Age: 3600
```

Now the screen itself. A file is picked, uploaded straight to R2, and appears in the list with its size and a Remove control; the hidden field carries the key the server minted (redacted below — it embeds a fresh UUID each run). Remove then takes it out of the list *and* deletes the object, which is why the last line reports it absent from the bucket.

```bash
set -e
printf "US-H05 attachment fixture.\n" > /tmp/us-h05-fixture.txt

rodney --local open http://localhost:5173/login >/dev/null
rodney --local waitstable >/dev/null
rodney --local js "fetch(\x27/api/auth/verify-code\x27,{method:\x27POST\x27,body:JSON.stringify({code:\x27123456\x27})}).then(r=>r.status)" >/dev/null

rodney --local open http://localhost:5173/compose >/dev/null
rodney --local waitstable >/dev/null

echo "Picker present:      $(rodney --local js "!!document.querySelector(\x27#attach-input\x27) && document.querySelector(\x27#attach-input\x27).multiple")"
echo "Drop zone label:     $(rodney --local js "document.querySelector(\x27[aria-label=\\\"Attach files\\\"]\x27).innerText.split(\x27\n\x27)[1]")"

rodney --local file "#attach-input" /tmp/us-h05-fixture.txt >/dev/null
sleep 4

echo "Listed:              $(rodney --local js "document.querySelector(\x27ul li\x27).innerText.replace(/\s+/g,\x27 \x27).trim()")"
echo "Submitted key:       $(rodney --local js "JSON.parse(document.querySelector(\x27input[name=attachments]\x27).value)[0].key" | tr -d \x27"\x27 | sed -E "s/[0-9a-f-]{36}/<upload-id>/")"
echo "Submitted size:      $(rodney --local js "JSON.parse(document.querySelector(\x27input[name=attachments]\x27).value)[0].sizeBytes")"

KEY=$(rodney --local js "JSON.parse(document.querySelector(\x27input[name=attachments]\x27).value)[0].key" | tr -d \x27"\x27)
rodney --local click "button[aria-label=\"Remove us-h05-fixture.txt\"]" >/dev/null
sleep 2
echo "After Remove, list:  $(rodney --local js "document.querySelectorAll(\x27ul li\x27).length") rows, field $(rodney --local js "document.querySelector(\x27input[name=attachments]\x27).value")"
echo "Object in R2:        $(node --env-file=.env -e "
const {S3Client,HeadObjectCommand}=require(\"@aws-sdk/client-s3\");
const c=new S3Client({region:\"auto\",endpoint:\`https://\${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com\`,credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}});
c.send(new HeadObjectCommand({Bucket:process.env.R2_BUCKET_NAME,Key:\"$KEY\"})).then(()=>console.log(\"PRESENT\")).catch(()=>console.log(\"absent\"));
")"
```

```output
error: JS error: eval js error: SyntaxError: Invalid or unexpected token <nil>
```

```bash
-
```

```output
bash: -c: option requires an argument
```

```bash
set -e
printf 'US-H05 attachment fixture.\n' > /tmp/us-h05-fixture.txt

rodney --local open http://localhost:5173/login >/dev/null
rodney --local waitstable >/dev/null
rodney --local js "fetch('/api/auth/verify-code',{method:'POST',body:JSON.stringify({code:'123456'})}).then(r=>r.status)" >/dev/null

rodney --local open http://localhost:5173/compose >/dev/null
rodney --local waitstable >/dev/null

echo "Picker accepts many:  $(rodney --local js "document.querySelector('#attach-input').multiple")"
echo "Drop zone says:       $(rodney --local js "document.querySelector('[aria-label=\"Attach files\"]').innerText.split('\n')[1]")"

rodney --local file '#attach-input' /tmp/us-h05-fixture.txt >/dev/null
sleep 4

echo "Listed as:            $(rodney --local js "document.querySelector('ul li').innerText.replace(/\s+/g,' ').trim()")"
echo "Submitted key:        $(rodney --local js "JSON.parse(document.querySelector('input[name=attachments]').value)[0].key" | tr -d '"' | sed -E 's/[0-9a-f-]{36}/<upload-id>/')"
echo "Submitted size:       $(rodney --local js "JSON.parse(document.querySelector('input[name=attachments]').value)[0].sizeBytes")"

KEY=$(rodney --local js "JSON.parse(document.querySelector('input[name=attachments]').value)[0].key" | tr -d '"')
rodney --local click 'button[aria-label="Remove us-h05-fixture.txt"]' >/dev/null
sleep 2
echo "After Remove, rows:   $(rodney --local js "document.querySelectorAll('ul li').length"), field $(rodney --local js "document.querySelector('input[name=attachments]').value")"
echo "That object in R2:    $(node --env-file=.env -e '
const {S3Client,HeadObjectCommand}=require("@aws-sdk/client-s3");
const c=new S3Client({region:"auto",endpoint:`https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,credentials:{accessKeyId:process.env.R2_ACCESS_KEY_ID,secretAccessKey:process.env.R2_SECRET_ACCESS_KEY}});
c.send(new HeadObjectCommand({Bucket:process.env.R2_BUCKET_NAME,Key:process.argv[1]})).then(()=>console.log("PRESENT")).catch(()=>console.log("absent"));
' "$KEY")"
```

```output
Picker accepts many:  true
Drop zone says:       or drop files here — up to 25 MB in total
Listed as:            us-h05-fixture.txt 27 B Remove
Submitted key:        outbound/pending/<upload-id>/us-h05-fixture.txt
Submitted size:       27
After Remove, rows:   0, field []
That object in R2:    absent
```

The limit is enforced on both sides, and the two enforcements have different jobs. The browser refuses an oversize file at pick time so nothing is uploaded at all; the endpoint refuses to mint a URL for one; and the send re-derives every size from R2's HEAD, so understating a size in the form buys nothing. The last line is the guard that matters most: the DELETE endpoint only accepts `outbound/pending/` keys, so it can never be talked into erasing a real message's attachment.

```bash
head -c 26000000 /dev/zero > /tmp/us-h05-too-big.bin

rodney --local open http://localhost:5173/compose >/dev/null
rodney --local waitstable >/dev/null
rodney --local file '#attach-input' /tmp/us-h05-too-big.bin >/dev/null
sleep 2

MINT='fetch("/compose/uploads",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({filename:"x.bin",contentType:"application/octet-stream",sizeBytes:26000000})}).then(r=>r.status)'
DROP='fetch("/compose/uploads",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({key:"inbound/some-email/some-attachment-report.pdf"})}).then(r=>r.status)'

ALERT=$(rodney --local text '[role=alert]')
ROWS=$(rodney --local js "document.querySelectorAll('ul li').length")
FIELD=$(rodney --local js "document.querySelector('input[name=attachments]').value")
MINT_STATUS=$(rodney --local js "$MINT")
DROP_STATUS=$(rodney --local js "$DROP")

echo "Client refuses it:    $ALERT"
echo "Nothing was queued:   $ROWS rows, field $FIELD"
echo "Endpoint refuses it:  HTTP $MINT_STATUS"
echo "DELETE of a real key: HTTP $DROP_STATUS"
```

```output
Client refuses it:    us-h05-too-big.bin doesn’t fit — attachments are limited to 25 MB in total.
Nothing was queued:   0 rows, field []
Endpoint refuses it:  HTTP 413
DELETE of a real key: HTTP 400
```

The screen with two files attached: the `+ Attach` button paired with a drop zone (drag-and-drop alone is unavailable to a keyboard and to most touch input), each file listed with its size and its own Remove, and Send enabled because both uploads have finished. While either one is still in flight, Send is disabled and the form says why — the hidden field only carries files that already have an R2 key, so a send that raced an upload would go out without it and nothing on screen would say so.

```bash {image}
![The compose screen with two attachments: an "Attachments" section holding a "+ Attach" button and a dashed drop zone reading "or drop files here — up to 25 MB in total", then notes-h05.txt (25 B) and payload-h05.txt (400 KB) each with a Remove control, above an enabled Send button](/tmp/us-h05-compose.png)
```

![The compose screen with two attachments: an "Attachments" section holding a "+ Attach" button and a dashed drop zone reading "or drop files here — up to 25 MB in total", then notes-h05.txt (25 B) and payload-h05.txt (400 KB) each with a Remove control, above an enabled Send button](eac73d59-2026-08-01.png)

-
