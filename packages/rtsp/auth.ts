import { crypto } from "@std/crypto";

// ---------------------------------------------------------------------------
// Hash helpers — async because Web Crypto (and @std/crypto) is async.
// @std/crypto is used instead of the Web Crypto built-in because Web Crypto
// does not support MD5, which is required for RTSP Digest auth.
// ---------------------------------------------------------------------------

function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function getMD5Hash(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("MD5", data);
  return bufToHex(buf);
}

export async function getSHA256Hash(str: string): Promise<string> {
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return bufToHex(buf);
}

// ---------------------------------------------------------------------------
// Auth types — ported from Yellowstone RTSPClient.ts
// ---------------------------------------------------------------------------

export type AuthType = "Digest" | "Basic";

export type AuthOptions = {
  type: AuthType;
  realm?: string;
  nonce?: string;
  algorithm?: "MD5" | "SHA-256";
};

// ---------------------------------------------------------------------------
// WWW-Authenticate header parsing — ported directly from Yellowstone
// ---------------------------------------------------------------------------

const WWW_AUTH_REGEX = new RegExp(
  '([a-zA-Z]+)\\s*=\\s*"?((?<=").*?(?=")|.*?(?=\\s*,?\\s*[a-zA-Z]+\\s*=)|.+[^\\s])',
  "g",
);

/**
 * Parse a WWW-Authenticate header value into an AuthOptions object.
 * Mirrors the parsing logic in RTSPClient#request (the 401 branch).
 *
 * When multiple WWW-Authenticate values are present the caller is expected
 * to have already selected the preferred one (Digest > Basic) before calling
 * this function, as Yellowstone does in _onData.
 */
export function parseAuthChallenge(authHeader: string): AuthOptions {
  const opts: AuthOptions = {
    type: authHeader.split(" ")[0] as AuthType,
    algorithm: "MD5", // default per Yellowstone
  };

  let match = WWW_AUTH_REGEX.exec(authHeader);
  while (match != null) {
    const prop = match[1];

    if (prop === "realm" && match[2]) {
      opts.realm = match[2];
    }
    if (prop === "nonce" && match[2]) {
      opts.nonce = match[2];
    }
    if (prop === "algorithm" && match[2]) {
      opts.algorithm = match[2] as AuthOptions["algorithm"];
    }

    match = WWW_AUTH_REGEX.exec(authHeader);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Authorization header generation — ported from Yellowstone
// _generateAuthString(requestName, url)
// ---------------------------------------------------------------------------

/**
 * Generate the value of the Authorization header for an RTSP request.
 *
 * Async because @std/crypto digest is async (MD5 is not available in the
 * built-in Web Crypto API, so we must use @std/crypto which is always async).
 *
 * Faithfully reproduces Yellowstone's _generateAuthString logic:
 *   - Basic  → "Basic " + btoa(username:password)
 *   - Digest → RFC 2617 HA1/HA2/response without qop/nc/cnonce (Yellowstone
 *              does not use qop), algorithm= field omitted for MD5 only.
 */
export async function generateAuthString(
  authOptions: AuthOptions,
  username: string,
  password: string,
  requestName: string,
  url: string,
): Promise<string> {
  if (authOptions.type === "Digest") {
    const hashFn = authOptions.algorithm === "SHA-256" ? getSHA256Hash : getMD5Hash;

    const ha1 = await hashFn(`${username}:${authOptions.realm}:${password}`);
    const ha2 = await hashFn(`${requestName}:${url}`);
    const ha3 = await hashFn(`${ha1}:${authOptions.nonce}:${ha2}`);

    // Yellowstone omits algorithm= for MD5, includes it for SHA-256
    if (authOptions.algorithm === "MD5") {
      return (
        `Digest username="${username}",realm="${authOptions.realm}",` +
        `nonce="${authOptions.nonce}",uri="${url}",response="${ha3}"`
      );
    } else {
      return (
        `Digest username="${username}",realm="${authOptions.realm}",` +
        `nonce="${authOptions.nonce}",algorithm=${authOptions.algorithm},` +
        `uri="${url}",response="${ha3}"`
      );
    }
  } else if (authOptions.type === "Basic") {
    // Yellowstone: Buffer.from(`${username}:${password}`).toString("base64")
    // btoa operates on Latin-1; for binary safety use TextEncoder + base64.
    // Using btoa here matches Yellowstone's behavior for ASCII credentials.
    const b64 = btoa(`${username}:${password}`);
    return `Basic ${b64}`;
  }

  return "";
}
