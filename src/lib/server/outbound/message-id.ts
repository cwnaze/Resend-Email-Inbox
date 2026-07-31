// The `Message-ID` this app mints for each outbound send (US-H02).
//
// Pure apart from `crypto.randomUUID` — no env, no db, no network — so the
// verification script can assert its shape directly.
//
// Why mint one at all, rather than storing whatever id Resend returns: the
// `emails.message_id` column is the join key the *inbound* side threads on
// (`findThreadIdByMessageIds` matches an arriving `In-Reply-To`/`References`
// against it), and Resend's returned email id is a different namespace that never
// appears in any header — storing *it* would store a value no reply could ever
// cite.
//
// The minted id is therefore both written to `emails.message_id` and put on the
// wire. One honest limitation, measured rather than assumed (see
// `email/resend.ts`): SES overwrites the `Message-ID` header, so the id a
// recipient's client puts in `In-Reply-To` is SES's, not this one. What does come
// back is the `References` chain, which is preserved verbatim and which the send
// therefore seeds with this id. That, plus the 30-day subject fallback, is how a
// reply finds its way back to the right thread.

/**
 * `<uuid@domain>`, angle brackets included — the form the header takes on the
 * wire and, because `In-Reply-To` arrives bracketed too, the form
 * `inbound/parse.ts` compares against. Storing the bare uuid would mean
 * stripping brackets in two places forever.
 */
export function newOutboundMessageId(senderAddress: string): string {
	return `<${crypto.randomUUID()}@${senderDomain(senderAddress)}>`;
}

/**
 * The domain half of the sending address. A `Message-ID` whose right-hand side
 * is a domain the sender doesn't own is a spam signal at some receivers, so it
 * is derived from the `from` address rather than hardcoded a second time.
 */
export function senderDomain(senderAddress: string): string {
	const at = senderAddress.lastIndexOf('@');
	if (at === -1 || at === senderAddress.length - 1) {
		throw new Error(`sender address has no domain: ${senderAddress}`);
	}
	return senderAddress.slice(at + 1).toLowerCase();
}
