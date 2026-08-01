// Applies the bucket CORS policy the compose attachment picker needs (US-H05).
// Run with (from the repo root):
//
//   node --env-file=.env node_modules/.bin/tsx src/lib/server/r2/set-cors.mts
//
// **This is infrastructure, not application code, and it has to have been run
// once per bucket for attachments to work at all.** The browser uploads straight
// to R2 over a presigned PUT (the app is on Vercel, whose functions cap a request
// body around 4.5 MB, so a 25 MB attachment can never travel through the form
// action). That PUT is a cross-origin request from this app's own origin to
// `<account>.r2.cloudflarestorage.com`, so without a CORS rule allowing it the
// browser refuses the upload before it starts and every attachment fails with an
// opaque network error.
//
// Standalone `tsx` like `verify.mts` next door, and for the same reason: it runs
// outside SvelteKit/Vite, so it builds its own client from `process.env` rather
// than importing `./index.ts` (which pulls in `$env/dynamic/private`).
//
// Re-running is safe and idempotent — `PutBucketCors` replaces the whole policy,
// so this file is the single description of it rather than a delta.
import { PutBucketCorsCommand, GetBucketCorsCommand, S3Client } from '@aws-sdk/client-s3';

const required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME'];
for (const name of required) {
	if (!process.env[name]) throw new Error(`${name} is not set`);
}

const client = new S3Client({
	region: 'auto',
	endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
	credentials: {
		accessKeyId: process.env.R2_ACCESS_KEY_ID!,
		secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!
	}
});

const bucket = process.env.R2_BUCKET_NAME!;

/**
 * Exactly the two origins this app is served from — never `*`.
 *
 * A wildcard would let any page on the internet issue the PUT, and while it
 * would still need a presigned URL to succeed, narrowing this costs nothing and
 * removes a whole class of "some other tab did that" question later.
 */
const ALLOWED_ORIGINS = ['http://localhost:5173', 'https://mail.caseynazelrod.com'];

async function main() {
	await client.send(
		new PutBucketCorsCommand({
			Bucket: bucket,
			CORSConfiguration: {
				CORSRules: [
					{
						AllowedOrigins: ALLOWED_ORIGINS,
						// PUT is the upload itself. GET is not needed — downloads are
						// presigned GETs the browser *navigates* to (a 302 from the download
						// endpoint), which is not a CORS request at all.
						AllowedMethods: ['PUT'],
						// The presigned PUT signs `Content-Type`, so the browser must be
						// allowed to send it; without this the preflight fails.
						AllowedHeaders: ['content-type'],
						MaxAgeSeconds: 3600
					}
				]
			}
		})
	);

	const applied = await client.send(new GetBucketCorsCommand({ Bucket: bucket }));
	console.log('CORS rules now on the bucket:');
	console.log(JSON.stringify(applied.CORSRules, null, 2));
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
