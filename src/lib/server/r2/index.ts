import {
	DeleteObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '$env/dynamic/private';

const REQUIRED_ENV_VARS = [
	'R2_ACCOUNT_ID',
	'R2_ACCESS_KEY_ID',
	'R2_SECRET_ACCESS_KEY',
	'R2_BUCKET_NAME'
] as const;

for (const name of REQUIRED_ENV_VARS) {
	if (!env[name]) {
		throw new Error(`${name} is not set`);
	}
}

const bucketName = env.R2_BUCKET_NAME as string;

// Cloudflare R2 is accessed via its S3-compatible API. The bucket is private
// (no public URL/custom domain) — callers get objects out via getR2SignedDownloadUrl,
// not a stored public URL.
const client = new S3Client({
	region: 'auto',
	endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
	credentials: {
		accessKeyId: env.R2_ACCESS_KEY_ID as string,
		secretAccessKey: env.R2_SECRET_ACCESS_KEY as string
	}
});

const DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 60 * 15; // 15 minutes

/**
 * Uploads a Buffer/Blob to the configured R2 bucket under `key` and returns
 * that same key. The bucket is private, so this does not return a public URL —
 * use `getR2SignedDownloadUrl` to hand the browser a time-limited download link.
 */
export async function uploadToR2(
	key: string,
	body: Buffer | Blob,
	contentType?: string
): Promise<{ key: string }> {
	const uploadBody = body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : body;

	await client.send(
		new PutObjectCommand({
			Bucket: bucketName,
			Key: key,
			Body: uploadBody,
			ContentType: contentType
		})
	);

	return { key };
}

/**
 * Deletes an object from the configured R2 bucket by key.
 */
export async function deleteFromR2(key: string): Promise<void> {
	await client.send(
		new DeleteObjectCommand({
			Bucket: bucketName,
			Key: key
		})
	);
}

/**
 * Generates a time-limited presigned GET URL for an object key, so the
 * browser can fetch/download a private-bucket object directly from R2.
 */
export async function getR2SignedDownloadUrl(
	key: string,
	expiresInSeconds: number = DEFAULT_SIGNED_URL_EXPIRY_SECONDS
): Promise<string> {
	const command = new GetObjectCommand({
		Bucket: bucketName,
		Key: key
	});

	return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}
