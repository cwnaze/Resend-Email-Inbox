// Standalone assertions for the pure compose address helpers (US-H01).
//
// `npx tsx src/lib/compose/verify-compose-addresses.mts`
//
// No db, no env, no browser: this is the module the Send gate and the server
// action both call, so it is the one place where "is this draft sendable" is
// decided, and it is worth pinning down without a browser in the loop. Imports
// are relative (not `$lib/...`) because bare `tsx` has no Vite alias resolution
// — same constraint as `server/db/inbox.ts` and `server/inbox/html.ts`.
//
// Extend this script when the compose helpers grow (per CLAUDE.md: extend the
// area's verify script rather than adding a new ad hoc one).
import {
	activeEntry,
	isValidAddress,
	parseAddressList,
	replaceActiveEntry,
	suggestContacts,
	validateComposeDraft,
	MAX_CONTACT_SUGGESTIONS
} from './addresses.ts';

let passed = 0;
let failed = 0;

function check(label: string, actual: unknown, expected: unknown) {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		passed += 1;
		console.log(`  ok   ${label}`);
	} else {
		failed += 1;
		console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`);
	}
}

console.log('isValidAddress');
for (const good of [
	'a@b.co',
	'casey@caseynazelrod.com',
	'first.last+tag@sub.example.co.uk',
	'  padded@example.com  '
]) {
	check(`accepts ${JSON.stringify(good)}`, isValidAddress(good), true);
}
for (const bad of [
	'',
	'nope',
	'no@domain',
	'no@domain.',
	'@example.com',
	'a b@example.com',
	'two@@example.com',
	'trailing@-example.com',
	'a@example.c'
]) {
	check(`rejects ${JSON.stringify(bad)}`, isValidAddress(bad), false);
}

console.log('parseAddressList');
check('single address, lowercased', parseAddressList('Casey@Example.COM'), {
	addresses: ['casey@example.com'],
	invalid: []
});
check('comma and semicolon both separate', parseAddressList('a@x.com, b@x.com; c@x.com'), {
	addresses: ['a@x.com', 'b@x.com', 'c@x.com'],
	invalid: []
});
check('display-name form is unwrapped', parseAddressList('Casey N <casey@x.com>'), {
	addresses: ['casey@x.com'],
	invalid: []
});
check('duplicates collapse case-insensitively', parseAddressList('A@x.com, a@X.com'), {
	addresses: ['a@x.com'],
	invalid: []
});
check('a trailing separator is not an error', parseAddressList('a@x.com, '), {
	addresses: ['a@x.com'],
	invalid: []
});
check('empty field yields nothing at all', parseAddressList('   '), {
	addresses: [],
	invalid: []
});
check('bad entries are reported, good ones still parsed', parseAddressList('a@x.com, oops'), {
	addresses: ['a@x.com'],
	invalid: ['oops']
});
check('order of first appearance is preserved', parseAddressList('z@x.com, a@x.com'), {
	addresses: ['z@x.com', 'a@x.com'],
	invalid: []
});
// The shape a copy-paste out of another mail client produces. Splitting on the
// comma inside the quoted display name used to leave `"Doe` behind as a
// permanently invalid entry, which disabled Send with no way out but retyping.
check(
	'a comma inside a quoted display name does not separate',
	parseAddressList('"Doe, Jane" <jane@x.com>, bob@x.com'),
	{ addresses: ['jane@x.com', 'bob@x.com'], invalid: [] }
);
check(
	'a semicolon inside angle brackets does not separate',
	parseAddressList('Jane <jane;odd@x.com>'),
	{ addresses: [], invalid: ['jane;odd@x.com'] }
);

console.log('validateComposeDraft');
const base = { to: '', cc: '', subject: '', body: '' };
check('an empty draft is not sendable', validateComposeDraft(base), {
	valid: false,
	to: [],
	cc: [],
	errors: { to: 'Add at least one recipient.', content: 'Add a subject or a message body.' }
});
check(
	'a valid draft hands back the parsed recipients, so the send path need not re-parse',
	validateComposeDraft({
		to: 'A@x.com, a@x.com; Bo <bo@x.com>',
		cc: 'cc@x.com',
		subject: 'hi',
		body: ''
	}),
	{ valid: true, to: ['a@x.com', 'bo@x.com'], cc: ['cc@x.com'], errors: {} }
);
check(
	'the same address in To and Cc is refused, not delivered twice',
	validateComposeDraft({ ...base, to: 'a@x.com', cc: 'A@x.com', subject: 'hi' }),
	{ valid: false, to: ['a@x.com'], cc: [], errors: { cc: 'Already in To: a@x.com' } }
);
check(
	'recipient + subject is sendable',
	validateComposeDraft({ ...base, to: 'a@x.com', subject: 'hi' }),
	{ valid: true, to: ['a@x.com'], cc: [], errors: {} }
);
check(
	'recipient + body only is sendable',
	validateComposeDraft({ ...base, to: 'a@x.com', body: 'hi' }),
	{ valid: true, to: ['a@x.com'], cc: [], errors: {} }
);
check(
	'a body of only whitespace is no body',
	validateComposeDraft({ ...base, to: 'a@x.com', body: '   \n  ' }),
	{ valid: false, to: ['a@x.com'], cc: [], errors: { content: 'Add a subject or a message body.' } }
);
check(
	'content without a recipient is not sendable',
	validateComposeDraft({ ...base, subject: 'hi' }),
	{ valid: false, to: [], cc: [], errors: { to: 'Add at least one recipient.' } }
);
check(
	'a malformed To blocks send and names the offender',
	validateComposeDraft({ ...base, to: 'a@x.com, oops', subject: 'hi' }),
	{ valid: false, to: ['a@x.com'], cc: [], errors: { to: 'Not a valid address: oops' } }
);
check(
	'an empty Cc is fine (Cc is optional)',
	validateComposeDraft({ ...base, to: 'a@x.com', cc: '', subject: 'hi' }),
	{ valid: true, to: ['a@x.com'], cc: [], errors: {} }
);
check(
	'a malformed Cc blocks send',
	validateComposeDraft({ ...base, to: 'a@x.com', cc: 'nope', subject: 'hi' }),
	{ valid: false, to: ['a@x.com'], cc: [], errors: { cc: 'Not a valid address: nope' } }
);

console.log('activeEntry');
check('caret at the end targets the last entry', activeEntry('a@x.com, bo', 11), {
	text: ' bo',
	start: 8,
	end: 11
});
check('caret inside an earlier entry targets that one', activeEntry('a@x.com, b@x.com', 3), {
	text: 'a@x.com',
	start: 0,
	end: 7
});
check('an out-of-range caret is clamped, not thrown', activeEntry('a@x.com', 999), {
	text: 'a@x.com',
	start: 0,
	end: 7
});

check(
	'the caret scan ignores a comma inside a quoted name',
	activeEntry('"Doe, Jane" <j@x.com>', 21),
	{
		text: '"Doe, Jane" <j@x.com>',
		start: 0,
		end: 21
	}
);

console.log('replaceActiveEntry');
check(
	'replaces the fragment being typed and appends a separator',
	replaceActiveEntry('ca', 2, 'casey@x.com'),
	{
		value: 'casey@x.com, ',
		caret: 13
	}
);
check(
	'earlier addresses survive, with exactly one separator between',
	replaceActiveEntry('a@x.com, ca', 11, 'casey@x.com'),
	{ value: 'a@x.com, casey@x.com, ', caret: 22 }
);
check('text after the caret is kept', replaceActiveEntry('ca, b@x.com', 2, 'casey@x.com'), {
	value: 'casey@x.com, b@x.com',
	caret: 13
});

console.log('suggestContacts');
const contacts = [
	{ email: 'casey@example.com', name: 'Casey N' },
	{ email: 'luca@example.com', name: null },
	{ email: 'dana@other.com', name: 'Dana Casey' }
];
check('an empty fragment suggests nothing', suggestContacts(contacts, '  '), []);
check(
	'address prefix outranks a mid-string name hit',
	suggestContacts(contacts, 'casey').map((c) => c.email),
	['casey@example.com', 'dana@other.com']
);
check(
	'a name-only match is still found',
	suggestContacts(contacts, 'dana').map((c) => c.email),
	['dana@other.com']
);
check(
	'matching is case-insensitive',
	suggestContacts(contacts, 'CASEY@EX').map((c) => c.email),
	['casey@example.com']
);
check(
	'addresses already in the field are not re-offered',
	suggestContacts(contacts, 'example.com', ['CASEY@example.com']).map((c) => c.email),
	['luca@example.com']
);
check(
	'the suggestion list is capped',
	suggestContacts(
		Array.from({ length: 20 }, (_, i) => ({ email: `p${i}@example.com`, name: null })),
		'example.com'
	).length,
	MAX_CONTACT_SUGGESTIONS
);

console.log(`\n${passed}/${passed + failed} checks passed`);
if (failed > 0) process.exit(1);
