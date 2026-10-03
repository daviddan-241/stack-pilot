// Practical guardrails for browser memory, Render Free memory, JSON payloads, and provider context.
// These are intentionally bounded: no hosted service can accept literally unlimited files or prompts.
export const MAX_PROJECT_FILE_COUNT = 2_000;
export const MAX_PROJECT_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_BYTES = 25 * 1024 * 1024;

export const MAX_ZIP_ARCHIVE_BYTES = 100 * 1024 * 1024;
export const MAX_ZIP_ARCHIVES = 100;
export const MAX_ZIP_TOTAL_ARCHIVE_BYTES = 150 * 1024 * 1024;
export const MAX_ZIP_ENTRY_COUNT = 10_000;

// The complete paste is kept with the project. Only a bounded prefix can go to a free-model request.
export const MAX_RAW_INPUT_CHARS = 2_000_000;
export const MAX_ORGANIZER_INPUT_CHARS = 40_000;
export const MAX_ORGANIZER_SOURCE_BYTES = 60_000;

export const MAX_API_BODY_BYTES = 64 * 1024 * 1024;
