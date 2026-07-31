// What a reply pre-fills (US-H03, tasks/prd-feature-compose.md).
//
// Pure — no env, no db, no DOM — for the same reason `addresses.ts` is: the
// compose `load` builds the draft with these functions on the server, and
// `verify-compose-reply.mts`-style checks (they live in
// `verify-compose-addresses.mts`, per the one-script-per-area rule) exercise
// them under bare `tsx`. Nothing here reads a `$lib/...` alias for that reason.
//
// The *threading* half of the story is deliberately not here: which thread a
// reply joins and which `Message-ID` it cites are decided server-side from the
// parent row, never from anything the browser could hand back (see
// `compose/+page.server.ts`). This module only shapes text.

/**
 * Reply/forward prefixes this app recognises when deciding whether a subject is
 * *already* prefixed.
 *
 * Deliberately narrower than `server/inbound/threading.ts`'s `REPLY_PREFIX`,
 * which strips every localized variant it can (`Aw:`, `Sv:`, `Tr:` …) because
 * its job is to collapse a conversation onto one grouping key. Here the job is
 * the opposite one — writing a subject a human will read — and re-prefixing a
 * German correspondent's `Aw: Angebot` as `Re: Aw: Angebot` is a worse outcome
 * than the criterion's "not double-prefixed" strictly requires, so `Re:` and
 * `Fwd:`/`Fw:` (the forms this app itself writes) are what count.
 */
const SUBJECT_PREFIX = /^\s*(?:re|fwd?)\s*(?:[[(]\d+[\])])?\s*:\s*/i;

/** True when `subject` already opens with the given prefix, case-insensitively. */
function hasPrefix(subject: string, prefix: 'Re' | 'Fwd'): boolean {
	const match = SUBJECT_PREFIX.exec(subject);
	if (!match) return false;
	const found = match[0]
		.trim()
		.replace(/[[(]\d+[\])]/, '')
		.replace(/\s*:\s*$/, '')
		.trim();
	return prefix === 'Re' ? /^re$/i.test(found) : /^fwd?$/i.test(found);
}

/**
 * `Re: <subject>`, or the subject unchanged when it already carries a `Re:`.
 *
 * Only the *outermost* prefix is inspected: `Re: Fwd: lunch` is a reply to a
 * forward and stays as it is, while `Fwd: lunch` becomes `Re: Fwd: lunch` —
 * that inner `Fwd:` is part of what the subject says, not a prefix this reply
 * is adding. An empty subject yields a bare `Re:`… which reads as nothing at
 * all, so it stays empty and the send's own `(no subject)` placeholder covers
 * it.
 */
export function replySubject(subject: string): string {
	const trimmed = subject.trim();
	if (trimmed === '') return '';
	if (hasPrefix(trimmed, 'Re')) return trimmed;
	return `Re: ${trimmed}`;
}

export type QuotedOriginal = {
	/** How the original's author should be named in the attribution line. */
	sender: string;
	/** The already-formatted timestamp of the original message. */
	timestamp: string;
	/** The original message as plain text (`bodyPlainText` upstream). */
	body: string;
};

/**
 * The `>`-quoted copy of the message being replied to, attribution line first.
 *
 * `> ` per line rather than a `<blockquote>` because compose sends plain text
 * only (see `email/resend.ts`): the angle-bracket convention is what every mail
 * client renders as a quote, and it survives a body that is literally the
 * characters in the textarea. An empty line is quoted as a bare `>`, not `> `,
 * so the block has no trailing whitespace for a linter or a diff to argue with.
 *
 * A message with no readable body still gets its attribution line — "on this
 * date, this person wrote" is context even when what they wrote was an
 * attachment or an image.
 */
export function quoteOriginal(original: QuotedOriginal): string {
	const attribution = `On ${original.timestamp}, ${original.sender} wrote:`;
	const quoted = original.body
		.split('\n')
		.map((line) => {
			const withoutCr = line.endsWith('\r') ? line.slice(0, -1) : line;
			return withoutCr === '' ? '>' : `> ${withoutCr}`;
		})
		.join('\n');
	return original.body === '' ? attribution : `${attribution}\n${quoted}`;
}

/**
 * The body a reply opens with: two blank lines to write in, then the quote.
 *
 * The caret lands at position 0 in a browser, so the owner types above the
 * quote — top-posting, which is what every mail client this inbox talks to
 * does. The blank lines are what visually separate the new message from the
 * quoted one (the story's third criterion) once it is sent as plain text.
 */
export function replyBody(original: QuotedOriginal): string {
	return `\n\n${quoteOriginal(original)}\n`;
}

/**
 * Who a reply goes to.
 *
 * For an inbound message that is its sender. For a message *this app* sent it
 * is that message's own recipients — replying to your own sent mail means
 * writing to the same people again, and a "reply" addressed to `from`, which is
 * the owner's own address, is a mail to oneself.
 *
 * De-duplicated and lowercased to match `parseAddressList`, and the owner's own
 * sending address is dropped so replying never Cc's the sender back into their
 * own inbox.
 */
export function replyRecipients(
	original: {
		direction: 'inbound' | 'outbound';
		fromEmail: string;
		toEmails: string[];
	},
	ownAddress: string
): string[] {
	const candidates = original.direction === 'outbound' ? original.toEmails : [original.fromEmail];
	const own = ownAddress.trim().toLowerCase();
	const seen = new Set<string>();
	const recipients: string[] = [];
	for (const candidate of candidates) {
		const normalized = candidate.trim().toLowerCase();
		if (normalized === '' || normalized === own || seen.has(normalized)) continue;
		seen.add(normalized);
		recipients.push(normalized);
	}
	return recipients;
}
