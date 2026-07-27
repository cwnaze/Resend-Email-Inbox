// Inbound payload parsing (US-E02, tasks/prd-feature-inbound-processing.md).
//
// Two stages, deliberately separate:
//
//  1. `parseInboundWebhookEvent` — validates the *verified* Svix payload
//     envelope and pulls out the one field that matters: `data.email_id`.
//     Resend's `email.received` webhook carries **metadata only** — no body, no
//     headers, no attachment content ("This design choice supports large
//     attachments in serverless environments that have limited request body
//     sizes"). So the webhook alone cannot satisfy this story's acceptance
//     criteria: the `From:` display name, `In-Reply-To`, the `Date:` header and
//     `html`/`text` all live behind the Received-emails API.
//  2. `parseReceivedEmail` — turns the record fetched by `fetchReceivedEmail`
//     into the shape the `emails`/`contacts` tables want.
//
// Both stages are pure (no env, no db, no network) so a standalone `tsx` script
// can exercise them against a captured fixture — see `verify-inbound-parse.mts`.
import type { GetReceivingEmailResponseSuccess } from 'resend';

/** The subset of a fetched received-email record this module reads. */
export type ReceivedEmailRecord = GetReceivingEmailResponseSuccess;

export type ParsedInboundEmail = {
	/** Resend's own id for the received email (not the RFC Message-ID). */
	resendEmailId: string;
	/** RFC 5322 Message-ID, angle brackets included, as Resend reports it. */
	messageId: string;
	/** `In-Reply-To` header if present — US-E04 threads on this. */
	inReplyTo: string | null;
	/** `References` header, split into individual message ids (may be empty). */
	references: string[];
	fromEmail: string;
	/** Display name from the `From:` header, or null if it was a bare address. */
	fromName: string | null;
	toEmails: string[];
	ccEmails: string[];
	bccEmails: string[];
	replyToEmails: string[];
	subject: string;
	bodyHtml: string | null;
	bodyText: string | null;
	/** `Date:` header when parseable, else Resend's `created_at`. */
	receivedAt: Date;
	attachments: ReceivedEmailRecord['attachments'];
};

export type ParseEventResult = { ok: true; emailId: string } | { ok: false; reason: string };

/**
 * Validates a verified webhook payload and extracts `data.email_id`.
 *
 * Returns a discriminated result rather than throwing: a payload that is
 * well-formed-but-uninteresting (some other Resend event type reaching this
 * endpoint) is not an error the caller should 500 on, and the reason string is
 * for the server log either way.
 */
export function parseInboundWebhookEvent(payload: unknown): ParseEventResult {
	if (typeof payload !== 'object' || payload === null) {
		return { ok: false, reason: 'payload is not an object' };
	}

	const { type, data } = payload as { type?: unknown; data?: unknown };

	if (type !== 'email.received') {
		return { ok: false, reason: `unhandled event type: ${String(type)}` };
	}
	if (typeof data !== 'object' || data === null) {
		return { ok: false, reason: 'payload.data is not an object' };
	}

	const { email_id: emailId } = data as { email_id?: unknown };
	if (typeof emailId !== 'string' || emailId === '') {
		return { ok: false, reason: 'payload.data.email_id is missing' };
	}

	return { ok: true, emailId };
}

/**
 * Reads every value of a header, case-insensitively.
 *
 * Resend lowercases header names, but it also hands some values back
 * *JSON-encoded* rather than raw — an observed real delivery had
 * `date: "\"2026-07-25T15:15:31.000Z\""` (a quoted string) and
 * `received: "[\"from …\"]"` (an array, which is how a header that occurred
 * more than once comes back). So a `"`-prefixed value is decoded to a string
 * and a `[`-prefixed one to a list; anything else is taken verbatim.
 *
 * Decoding the array form matters beyond `received`: a `References` header that
 * arrived that way would otherwise be whitespace-split into JSON punctuation
 * (`["<id1>",`) and silently poison threading rather than fail.
 */
function headerValues(headers: ReceivedEmailRecord['headers'], name: string): string[] {
	if (!headers) return [];
	const raw = headers[name] ?? headers[name.toLowerCase()];
	if (typeof raw !== 'string') return [];

	const value = raw.trim();
	if (value.startsWith('"') || value.startsWith('[')) {
		try {
			const decoded: unknown = JSON.parse(value);
			if (typeof decoded === 'string') return [decoded.trim()].filter((v) => v !== '');
			if (Array.isArray(decoded)) {
				return decoded
					.filter((entry): entry is string => typeof entry === 'string')
					.map((entry) => entry.trim())
					.filter((entry) => entry !== '');
			}
		} catch {
			// Not JSON — a header value that merely starts with a quote, e.g. a
			// display name like `"Google" <noreply@google.com>`. Keep it verbatim.
		}
	}
	return value === '' ? [] : [value];
}

/** The single value of a header — the first, when it occurred more than once. */
function header(headers: ReceivedEmailRecord['headers'], name: string): string | null {
	return headerValues(headers, name)[0] ?? null;
}

/**
 * Splits a `From:`-style header into display name and address.
 *
 * Only the name is taken from here — the address comes from Resend's own
 * `from` field, which the docs guarantee is the bare address. Trusting the
 * header for the address would let a crafted `From:` disagree with the envelope
 * Resend actually validated.
 */
function parseDisplayName(fromHeader: string | null): string | null {
	if (!fromHeader) return null;

	const angle = fromHeader.lastIndexOf('<');
	if (angle === -1) return null; // bare address, no display name

	let name = fromHeader.slice(0, angle).trim();
	// Strip one layer of RFC 5322 quoting: `"Google" <a@b>`.
	if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
		name = name.slice(1, -1).trim();
	}
	return name === '' ? null : name;
}

/**
 * `References` is a whitespace-separated list of message ids. It takes *all*
 * values rather than just the first: a header that occurred more than once
 * comes back as a list, and the ids from each occurrence are all references.
 */
function parseReferences(values: string[]): string[] {
	return values.flatMap((value) => value.split(/\s+/)).filter((ref) => ref !== '');
}

function parseDate(value: string | null, fallback: string): Date {
	for (const candidate of [value, fallback]) {
		if (!candidate) continue;
		const parsed = new Date(candidate);
		if (!Number.isNaN(parsed.getTime())) return parsed;
	}
	// Both unparseable: better a row with "now" than a failed ingestion.
	return new Date();
}

/** Normalizes an address list, dropping empties (Resend sends `[]` or null). */
function addressList(value: string[] | null | undefined): string[] {
	return (value ?? []).map((address) => address.trim()).filter((address) => address !== '');
}

/**
 * Projects a fetched received-email record onto the fields the app stores.
 *
 * US-E03 sanitizes `bodyHtml` before it is persisted — this function returns it
 * exactly as Resend served it and makes no safety claim about it.
 */
export function parseReceivedEmail(received: ReceivedEmailRecord): ParsedInboundEmail {
	const fromEmail = received.from.trim().toLowerCase();

	return {
		resendEmailId: received.id,
		messageId: received.message_id,
		inReplyTo: header(received.headers, 'in-reply-to'),
		references: parseReferences(headerValues(received.headers, 'references')),
		fromEmail,
		fromName: parseDisplayName(header(received.headers, 'from')),
		toEmails: addressList(received.to),
		ccEmails: addressList(received.cc),
		bccEmails: addressList(received.bcc),
		replyToEmails: addressList(received.reply_to),
		subject: received.subject ?? '',
		bodyHtml: received.html ?? null,
		bodyText: received.text ?? null,
		receivedAt: parseDate(header(received.headers, 'date'), received.created_at),
		attachments: received.attachments ?? []
	};
}
