import {
	DeleteObjectCommand,
	GetObjectCommand,
	PutObjectCommand,
	S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '$env/dynamic/private';

function requireEnv(
	name: 'R2_ACCOUNT_ID' | 'R2_ACCESS_KEY_ID' | 'R2_SECRET_ACCESS_KEY' | 'R2_BUCKET_NAME'
): string {
	const value = env[name];
	if (!value) {
		throw new Error(`${name} is not set`);
	}
	return value;
}

const accountId = requireEnv('R2_ACCOUNT_ID');
const accessKeyId = requireEnv('R2_ACCESS_KEY_ID');
const secretAccessKey = requireEnv('R2_SECRET_ACCESS_KEY');
const bucketName = requireEnv('R2_BUCKET_NAME');

// Cloudflare R2 is accessed via its S3-compatible API. The bucket is private
// (no public URL/custom domain) — callers get objects out via getR2SignedDownloadUrl,
// not a stored public URL.
const client = new S3Client({
	region: 'auto',
	endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
	credentials: {
		accessKeyId,
		secretAccessKey
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

export type SignedDownloadUrlOptions = {
	expiresInSeconds?: number;
	/**
	 * `Content-Disposition` for R2 to answer with, overriding whatever the stored
	 * object carries. Must already be a complete, correctly-escaped header value
	 * (see `server/inbox/download.ts`).
	 */
	contentDisposition?: string;
	/** `Content-Type` for R2 to answer with, overriding the stored object's. */
	contentType?: string;
};

/**
 * Generates a time-limited presigned GET URL for an object key, so the
 * browser can fetch/download a private-bucket object directly from R2.
 *
 * The two response overrides are signed query parameters (S3's
 * `response-content-disposition` / `response-content-type`), so they are part of
 * the signature and cannot be tampered with by whoever holds the URL — which is
 * what lets a download link set the filename the browser saves under without
 * the stored object having to carry it.
 */
export async function getR2SignedDownloadUrl(
	key: string,
	options: SignedDownloadUrlOptions | number = {}
): Promise<string> {
	// The second parameter used to be a bare `expiresInSeconds` number; accept
	// both so existing callers keep working.
	const resolved: SignedDownloadUrlOptions =
		typeof options === 'number' ? { expiresInSeconds: options } : options;

	const command = new GetObjectCommand({
		Bucket: bucketName,
		Key: key,
		ResponseContentDisposition: resolved.contentDisposition,
		ResponseContentType: resolved.contentType
	});

	return getSignedUrl(client, command, {
		expiresIn: resolved.expiresInSeconds ?? DEFAULT_SIGNED_URL_EXPIRY_SECONDS
	});
}
