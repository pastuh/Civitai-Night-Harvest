/**
 * Light sanitizer for Civitai model/version HTML descriptions.
 * Strips scripts, iframes, and inline event handlers; keeps common formatting tags.
 */
export function sanitizeCivitaiHtml(html: string): string {
  let out = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?(?:iframe|object|embed|form|input|button|textarea|select|meta|link|base)[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*javascript:[^\s>]*/gi, '$1="#"')

  // Drop unknown tags but keep their text content (allowlist approach via strip of rare tags).
  out = out.replace(
    /<\/?(?!\/?(?:p|br|hr|div|span|strong|b|em|i|u|s|strike|del|ins|sub|sup|ul|ol|li|a|h[1-6]|blockquote|pre|code|table|thead|tbody|tr|th|td|img|figure|figcaption|mark|small)(?:\s|>|\/))[^>]+>/gi,
    ''
  )
  return out.trim()
}
