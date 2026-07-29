/**
 * Where the Zotero local API is, when it is not where Zotero usually puts it.
 *
 * Zotero's local API port is a preference, so an installation that moved it needs to be able
 * to say so — this is ordinary configuration, not a test hook. But it is configuration that
 * names *where the importer sends the library*, and this application's whole claim is that
 * nothing leaves the machine. So the address is admitted only when it is a loopback one: a
 * `WR_ZOTERO_ENDPOINT` pointing at somebody's server would turn "import my library" into
 * "post my library", and an environment variable is exactly the sort of thing that gets set
 * by something other than the person at the keyboard.
 *
 * A refused value falls back to the default rather than stopping the launch: the application
 * still works against a normal Zotero, and the refusal is logged rather than silent.
 */

/** Hosts that cannot leave this machine. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export interface EndpointDecision {
  /** The endpoint to use, or null to keep the built-in default. */
  readonly endpoint: string | null;
  /** Why a value was refused, for the log. Null when nothing was refused. */
  readonly refused: string | null;
}

/**
 * Decide what `WR_ZOTERO_ENDPOINT` means, if anything.
 *
 * The check is on the parsed URL's hostname rather than on the string, because
 * `http://127.0.0.1@evil.invalid/` and `http://localhost.evil.invalid/` both contain a
 * loopback name and neither is one.
 */
export function resolveZoteroEndpoint(value: string | undefined): EndpointDecision {
  if (value === undefined || value.trim() === '') return { endpoint: null, refused: null };

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { endpoint: null, refused: 'not a URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { endpoint: null, refused: `unsupported scheme ${url.protocol}` };
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    return { endpoint: null, refused: `${url.hostname} is not a loopback address` };
  }
  // Credentials would be sent to the local API and nowhere else, but they have no business in
  // a value whose only job is to name a port on this machine.
  if (url.username !== '' || url.password !== '') {
    return { endpoint: null, refused: 'credentials are not accepted' };
  }

  return { endpoint: `${url.protocol}//${url.host}`, refused: null };
}
