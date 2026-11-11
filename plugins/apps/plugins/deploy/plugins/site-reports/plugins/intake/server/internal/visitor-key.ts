function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A visitor's key for the admission gate: `sha256(process salt ‖ ip)`. The
 * salt is random per process and never stored, and the key lives only in the
 * gate's memory for one window — so no address, nor anything that could be
 * walked back to one, is ever written. Web Crypto, so it runs on every host.
 */
export function createVisitorKey(): (ip: string) => Promise<string> {
  const salt = hex(crypto.getRandomValues(new Uint8Array(32)));
  return async (ip) => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${salt}\n${ip}`),
    );
    return hex(new Uint8Array(digest));
  };
}
