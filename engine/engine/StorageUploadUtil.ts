/**
 * Utility for uploading files directly to S3 using presigned URLs.
 * This approach is more efficient than passing file content through the API server.
 */

import { getAgentUrl } from 'engine/agentUrl.js';

export interface UploadOptions {
    /** MIME type (default: application/octet-stream) */
    contentType?: string;
    /** Optional game ID for organizing files in S3 */
    gameId?: string;
    /** If true, sets Cache-Control: no-cache (for frequently updated files) */
    noCache?: boolean;
    /**
     * Called on success with the number of bytes actually STORED — the brotli size on
     * the transcode path, the gzipped size when the server requires
     * `Content-Encoding: gzip`, else the raw size. Lets callers report the true
     * at-rest/transfer size instead of the pre-compression byte length.
     */
    onUploaded?: (uploadedBytes: number) => void;
}

/**
 * Gzip `blob` if the platform can. Returns the input unchanged where
 * `CompressionStream` is missing, so callers must read `.size` off the RESULT.
 */
async function gzipBlob(blob: Blob): Promise<Blob> {
    if (typeof CompressionStream === 'undefined') return blob;
    const compressed = blob.stream().pipeThrough(new CompressionStream('gzip'));
    return await new Response(compressed).blob();
}

/**
 * Upload a gzipped body to the agent, which re-compresses it to brotli as it streams
 * into storage (`/api/upload-transcoded`). Returns the CloudFront URL + the STORED
 * byte count, or null when the caller should use the signed-URL path instead.
 *
 * Brotli is 15-25% smaller than gzip on baked voxel data, and the wire still carries
 * the gzipped body — an 87 MB level uploads as ~18 MB either way. The agent answers
 * `fallback` when it is at capacity or the transcode failed; anything unexpected
 * (an older agent with no such route, a network error) is treated the same way, so a
 * failure here only ever costs a slightly larger file.
 */
async function uploadTranscoded(
    gzipped: Blob,
    filename: string,
    contentType: string,
    gameId: string | undefined,
    noCache: boolean | undefined,
): Promise<{ url: string; storedBytes: number } | null> {
    try {
        const params = new URLSearchParams({ filename, contentType });
        if (gameId) params.set('gameId', gameId);
        if (noCache) params.set('noCache', 'true');
        const response = await fetch(`${getAgentUrl()}/api/upload-transcoded?${params}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: gzipped,
        });
        if (!response.ok) {
            console.log(`[StorageUploadUtil] transcode upload unavailable (${response.status}) — using signed URL`);
            return null;
        }
        const { cloudFrontUrl, size } = await response.json();
        if (typeof cloudFrontUrl !== 'string' || typeof size !== 'number') return null;
        console.log(`[StorageUploadUtil] Brotli ${filename}: ${gzipped.size} gz → ${size} br bytes`);
        return { url: cloudFrontUrl, storedBytes: size };
    } catch (error) {
        console.log('[StorageUploadUtil] transcode upload failed — using signed URL:', error);
        return null;
    }
}

/**
 * Upload binary data directly to S3 using a presigned URL.
 *
 * @param data - The file data as Uint8Array or string
 * @param filename - The filename (will be prefixed with timestamp by the server)
 * @param options - Upload options (contentType, gameId, noCache)
 * @returns The CloudFront URL of the uploaded file, or null on failure
 */
export async function uploadFile(
    data: Uint8Array | string,
    filename: string,
    options: UploadOptions = {}
): Promise<string | null> {
    const { contentType = 'application/octet-stream', gameId, noCache, onUploaded } = options;

    try {
        // 1. Get presigned URL from backend
        const urlResponse = await fetch(`${getAgentUrl()}/api/generate-upload-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, contentType, gameId, noCache })
        });

        if (!urlResponse.ok) {
            console.error('[StorageUploadUtil] Failed to get presigned URL:', urlResponse.status);
            return null;
        }

        const { signedUrl, cloudFrontUrl, cacheControl, contentEncoding } = await urlResponse.json();

        // 2. Create blob from data. Hand the typed-array view straight to Blob
        // (it respects byteOffset/length) rather than duplicating the buffer —
        // a 400 MB+ .vwld OOMs the tab when copied ("Array buffer allocation
        // failed"). Only SharedArrayBuffer-backed views need a real copy, since
        // Blob's part type rejects them.
        let blob: Blob;
        if (data instanceof Uint8Array) {
            const buf = data.buffer;
            // Normal ArrayBuffer: wrap the existing memory in a view (no copy).
            // SharedArrayBuffer (rare): copy into a normal buffer — Blob's part
            // type rejects shared-backed views.
            const part = buf instanceof ArrayBuffer
                ? new Uint8Array(buf, data.byteOffset, data.byteLength)
                : new Uint8Array(data);
            blob = new Blob([part], { type: contentType });
        } else {
            blob = new Blob([data], { type: contentType });
        }

        // 3. Gzip compress if server requires it
        let uploadBody: Blob = blob;
        if (contentEncoding === 'gzip') {
            uploadBody = await gzipBlob(blob);
            if (uploadBody !== blob) {
                console.log(`[StorageUploadUtil] Gzipped ${filename}: ${blob.size} → ${uploadBody.size} bytes`);
            }
        }

        // 3b. Prefer the agent's brotli transcode for anything the server wanted
        //     compressed: same gzipped bytes on the wire, 15-25% smaller at rest, and
        //     the size it reports is the real download size — so the figure shown in
        //     the Assets tab during editing is what a player will actually fetch.
        //     Falls through to the signed PUT below on any failure.
        if (contentEncoding === 'gzip' && uploadBody !== blob) {
            const transcoded = await uploadTranscoded(uploadBody, filename, contentType, gameId, noCache);
            if (transcoded) {
                console.log(`[StorageUploadUtil] Successfully uploaded ${filename} to ${transcoded.url}`);
                onUploaded?.(transcoded.storedBytes);
                return transcoded.url;
            }
        }

        // 4. Upload directly to storage (S3 or GCS)
        // Include Cache-Control header — GCS signed URLs require it to match the signed headers
        const headers: Record<string, string> = { 'Content-Type': contentType };
        if (cacheControl) {
            headers['Cache-Control'] = cacheControl;
        }
        if (contentEncoding) {
            headers['Content-Encoding'] = contentEncoding;
        }

        const uploadResponse = await fetch(signedUrl, {
            method: 'PUT',
            headers,
            body: uploadBody
        });

        if (!uploadResponse.ok) {
            console.error('[StorageUploadUtil] Failed to upload:', uploadResponse.status);
            return null;
        }

        console.log(`[StorageUploadUtil] Successfully uploaded ${filename} to ${cloudFrontUrl}`);
        onUploaded?.(uploadBody.size);
        return cloudFrontUrl;

    } catch (error) {
        console.error('[StorageUploadUtil] Upload error:', error);
        return null;
    }
}

/** @deprecated Use uploadFile instead */
export const uploadToS3 = uploadFile;
