/**
 * Automated clients — crawlers and HTTP libraries — whose requests to a public
 * route are not a person: analytics does not count them as visits, and the
 * contact form files their messages as spam. Deliberately narrow: it names
 * crawlers and HTTP libraries, not headless browsers, so the repo's own
 * Playwright checks still record and send (that is how both are verified).
 */
const BOT_PATTERN =
  /\bbot\b|bot[/;-]|crawl|spider|slurp|mediapartners|facebookexternalhit|embedly|preview|curl\/|wget\/|python-requests|python-urllib|aiohttp|go-http-client|okhttp|java\/|libwww|httpclient|node-fetch|axios\/|undici/i;

export function isBotUserAgent(ua: string): boolean {
  return ua.trim().length === 0 || BOT_PATTERN.test(ua);
}
