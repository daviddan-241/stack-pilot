// Practical guardrails for browser memory, Render Free memory, JSON payloads, and provider context.
// The complete prompt has no app-level character cap; each free-model request is bounded and losslessly chunked.
export const MAX_PROJECT_FILE_COUNT = 2_000;
export const MAX_PROJECT_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_BYTES = 25 * 1024 * 1024;

export const MAX_ZIP_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const MAX_ZIP_ARCHIVES = 100;
export const MAX_ZIP_TOTAL_ARCHIVE_BYTES = 150 * 1024 * 1024;
export const MAX_ZIP_ENTRY_COUNT = 10_000;

export const MAX_ORGANIZER_CHUNK_CHARS = 20_000;
export const MAX_REVIEW_NOTES_CHARS = 14_000;
export const MAX_API_BODY_BYTES = 64 * 1024 * 1024;
