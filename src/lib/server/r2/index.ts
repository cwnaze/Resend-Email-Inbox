import {
	DeleteObjectCommand,
	GetObjectCommand,
	HeadObjectCommand,
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
 * Reads an object back out of the bucket as bytes (US-H04).
 *
 * The browser never uses this — a download link is presigned so the bytes go
 * straight from R2 to the client (`getR2SignedDownloadUrl`). It exists for the
 * one case where the *server* needs the content: forwarding an attachment, whose
 * bytes have to be handed to Resend and written back under a new key.
 */
export async function downloadFromR2(key: string): Promise<Buffer> {
	const response = await client.send(
		new GetObjectCommand({
			Bucket: bucketName,
			Key: key
		})
	);
	if (!response.Body) {
		throw new Error(`R2 object ${key} has no body`);
	}
	return Buffer.from(await response.Body.transformToByteArray());
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
 * What the bucket says an object actually is (US-H05).
 *
 * Used on the send path to re-derive a browser-uploaded attachment's size and
 * content type from R2 rather than from the form that named its key: the size is
 * what the 25 MB limit is enforced against, so taking the client's word for it
 * would make the limit advisory.
 */
export async function headR2Object(
	key: string
): Promise<{ sizeBytes: number; contentType: string | null }> {
	const response = await client.send(
		new HeadObjectCommand({
			Bucket: bucketName,
			Key: key
		})
	);
	return {
		sizeBytes: response.ContentLength ?? 0,
		contentType: response.ContentType ?? null
	};
}

/**
 * A time-limited presigned **PUT** URL, so the browser can upload an attachment
 * straight into the private bucket (US-H05).
 *
 * Direct-to-R2 rather than posting the bytes through a form action, because the
 * app is deployed on Vercel and a serverless function's request body is capped
 * around 4.5 MB — a 25 MB attachment could never reach the action at all. The
 * key is minted server-side (`compose/uploads`), never supplied by the caller.
 *
 * `contentType` is part of the signature, so the browser's PUT must send exactly
 * that `Content-Type` header or R2 rejects it. That is deliberate: it pins the
 * stored object's type to the one the endpoint approved.
 */
export async function getR2SignedUploadUrl(
	key: string,
	contentType: string,
	expiresInSeconds: number = DEFAULT_SIGNED_URL_EXPIRY_SECONDS
): Promise<string> {
	const command = new PutObjectCommand({
		Bucket: bucketName,
		Key: key,
		ContentType: contentType
	});

	return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
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
	options: SignedDownloadUrlOptions = {}
): Promise<string> {
	const command = new GetObjectCommand({
		Bucket: bucketName,
		Key: key,
		ResponseContentDisposition: options.contentDisposition,
		ResponseContentType: options.contentType
	});

	return getSignedUrl(client, command, {
		expiresIn: options.expiresInSeconds ?? DEFAULT_SIGNED_URL_EXPIRY_SECONDS
	});
}
