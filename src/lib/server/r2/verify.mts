// Standalone smoke test for the R2 utilities in ./index.ts, exercised
// directly against the real Cloudflare R2 bucket configured in the repo's
// root .env. Run with (from the repo root):
//
//   node --env-file=.env node_modules/.bin/tsx src/lib/server/r2/verify.mts
//
// This runs outside SvelteKit/Vite (so it can't import '$env/dynamic/private'
// or ./index.ts directly, which pulls that in), but performs the exact same
// S3-compatible calls: put an object, presign+fetch it, delete it, and
// confirm the presigned URL 404s afterward. Safe to re-run — each run uses a
// fixed key and cleans up after itself.
import {
	DeleteObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

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
const key = 'smoke-test/us-a02-showboat.txt';
const bodyText = 'ralph us-a02 smoke test';

async function main() {
	await client.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: Buffer.from(bodyText),
			ContentType: 'text/plain'
		})
	);
	console.log('upload: ok');

	const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
		expiresIn: 60
	});
	console.log('presigned url is https:', url.startsWith('https://'));

	const res = await fetch(url);
	const text = await res.text();
	console.log('fetch via presigned url status:', res.status);
	console.log('fetched body matches:', text === bodyText);

	await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
	console.log('delete: ok');

	const resAfterDelete = await fetch(url);
	console.log('fetch after delete status (expect 4xx):', resAfterDelete.status);
}

main().catch((err) => {
	console.error('SMOKE TEST FAILED', err);
	process.exitCode = 1;
});
