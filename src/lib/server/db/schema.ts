// Drizzle schema for the Custom Email Inbox database.
//
// Full data model per tasks/prd-data-model.md (US-D01): contacts, threads,
// emails, attachments, auth_codes, sessions.
//
// SQLite/libSQL has no native boolean or JSON type: booleans are stored as
// `integer` with `{ mode: 'boolean' }`, address lists as JSON-encoded text
// columns (`text({ mode: 'json' })`), and timestamps as unix milliseconds
// (`integer` with `{ mode: 'timestamp_ms' }`), per the Data Model PRD's
// Technical Considerations.

import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const contacts = sqliteTable(
	'contacts',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		email: text('email').notNull(),
		name: text('name'),
		autoCreated: integer('auto_created', { mode: 'boolean' }).notNull().default(true),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch('subsec') * 1000)`),
		updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch('subsec') * 1000)`)
	},
	(table) => [uniqueIndex('contacts_email_unique').on(table.email)]
);

export const threads = sqliteTable(
	'threads',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		subject: text('subject').notNull(),
		lastMessageAt: integer('last_message_at', { mode: 'timestamp_ms' }).notNull(),
		isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch('subsec') * 1000)`)
	},
	(table) => [index('threads_last_message_at_idx').on(table.lastMessageAt)]
);

export const emails = sqliteTable(
	'emails',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		threadId: text('thread_id')
			.notNull()
			.references(() => threads.id),
		messageId: text('message_id').notNull(),
		inReplyTo: text('in_reply_to'),
		direction: text('direction', { enum: ['inbound', 'outbound'] }).notNull(),
		fromEmail: text('from_email').notNull(),
		fromName: text('from_name'),
		toEmails: text('to_emails', { mode: 'json' }).notNull().$type<string[]>(),
		ccEmails: text('cc_emails', { mode: 'json' }).$type<string[]>(),
		bccEmails: text('bcc_emails', { mode: 'json' }).$type<string[]>(),
		subject: text('subject').notNull(),
		bodyText: text('body_text'),
		bodyHtml: text('body_html'),
		isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
		isDeleted: integer('is_deleted', { mode: 'boolean' }).notNull().default(false),
		receivedAt: integer('received_at', { mode: 'timestamp_ms' }).notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch('subsec') * 1000)`)
	},
	(table) => [
		uniqueIndex('emails_message_id_unique').on(table.messageId),
		index('emails_thread_id_idx').on(table.threadId),
		index('emails_is_read_is_deleted_idx').on(table.isRead, table.isDeleted)
	]
);

export const attachments = sqliteTable(
	'attachments',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		emailId: text('email_id')
			.notNull()
			.references(() => emails.id),
		filename: text('filename').notNull(),
		contentType: text('content_type').notNull(),
		sizeBytes: integer('size_bytes').notNull(),
		r2ObjectKey: text('r2_object_key').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch('subsec') * 1000)`)
	},
	(table) => [index('attachments_email_id_idx').on(table.emailId)]
);

export const authCodes = sqliteTable(
	'auth_codes',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		codeHash: text('code_hash').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch('subsec') * 1000)`),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
		usedAt: integer('used_at', { mode: 'timestamp_ms' }),
		attemptCount: integer('attempt_count').notNull().default(0)
	},
	(table) => [index('auth_codes_expires_at_idx').on(table.expiresAt)]
);

export const sessions = sqliteTable(
	'sessions',
	{
		id: text('id')
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		tokenHash: text('token_hash').notNull(),
		createdAt: integer('created_at', { mode: 'timestamp_ms' })
			.notNull()
			.default(sql`(unixepoch('subsec') * 1000)`),
		expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull()
	},
	(table) => [uniqueIndex('sessions_token_hash_unique').on(table.tokenHash)]
);
