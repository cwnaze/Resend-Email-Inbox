import { defineConfig } from 'drizzle-kit';

if (!process.env.TURSO_DATABASE_URL) {
	throw new Error('TURSO_DATABASE_URL is not set');
}

export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'turso',
	dbCredentials: {
		url: process.env.TURSO_DATABASE_URL,
		authToken: process.env.TURSO_AUTH_TOKEN
	}
});
