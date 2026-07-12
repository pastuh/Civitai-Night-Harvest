import type { FetchedPreview } from './preview-fetch'

/** Minimal 1×1 JPEG used when Civitai has no downloadable preview. */
const PLACEHOLDER_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA8A/9k='

let cached: FetchedPreview | null = null

export function getPlaceholderPreview(): FetchedPreview {
  if (cached) return cached
  const buffer = Buffer.from(PLACEHOLDER_JPEG_BASE64, 'base64')
  cached = {
    url: '',
    base64: PLACEHOLDER_JPEG_BASE64,
    mime: 'image/jpeg',
    buffer
  }
  return cached
}
