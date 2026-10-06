import { authHeaders } from "../api/client";
import { parsePlist } from "./plist";
import type { SapEndpoints } from "./sap/types";

export interface BagOutput {
  authURL: string;
  /** Present when the bag advertises the SAP signing protocol. */
  sapEndpoints?: SapEndpoints;
}

export const defaultAuthURL =
  "https://auth.itunes.apple.com/auth/v1/native/fast/";

const NATIVE_AUTH_HOST = "auth.itunes.apple.com";
const LEGACY_AUTH_PATH = '/WebObjects/MZFinance.woa/wa/authenticate';

// 原生端点需要 /fast/；旧版端点也需要尾部斜杠，裸路径可能返回没有
// Location 的 301。仅规范化已知认证路径，保留 Apple 给出的主机和查询参数。
export function normalizeAuthURL(rawURL: string): string {
  let url: URL;
  try {
    url = new URL(rawURL);
  } catch {
    return rawURL;
  }
  if (url.hostname !== NATIVE_AUTH_HOST) {
    const legacyHost = url.hostname === 'buy.itunes.apple.com' ||
      /^p\d+-buy\.itunes\.apple\.com$/.test(url.hostname);
    if (legacyHost && url.pathname.replace(/\/+$/, '') === LEGACY_AUTH_PATH) {
      url.pathname = `${LEGACY_AUTH_PATH}/`;
      return url.toString();
    }
    return rawURL;
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (!path.endsWith("/fast")) {
    path += "/fast";
  }
  url.pathname = `${path}/`;
  return url.toString();
}

// Fetches the bag via the backend proxy.
// The backend fetches it using Node.js native HTTPS.
// The bag response is public data (Apple service URLs, no credentials).
export async function fetchBag(deviceId: string): Promise<BagOutput> {
  try {
    const resp = await fetch(`/api/bag?guid=${encodeURIComponent(deviceId)}`, {
      headers: authHeaders(),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      console.warn(
        `[Bag] Proxy request failed, using default auth endpoint: ${err.error || `HTTP ${resp.status}`}`,
      );
      return { authURL: defaultAuthURL };
    }

    const xml = await resp.text();
    const dict = parsePlist(xml) as Record<string, any>;

    // authenticateAccount used to live inside the urlBag dict; newer bag
    // responses move it to the plist root, so prefer the root and fall back.
    const urlBag = dict.urlBag as Record<string, any> | undefined;
    const authURL =
      (dict.authenticateAccount as string | undefined) ??
      (urlBag?.authenticateAccount as string | undefined);

    const bagValue = (key: string): string | undefined =>
      (dict[key] as string | undefined) ??
      (urlBag?.[key] as string | undefined);

    const setupURL = bagValue("sign-sap-setup");
    const certificateURL = bagValue("sign-sap-setup-cert");
    const versionText = bagValue("sign-sap-version");
    let sapEndpoints: SapEndpoints | undefined;
    if (setupURL && certificateURL && versionText) {
      const version = Number.parseInt(versionText, 10);
      if (Number.isFinite(version)) {
        sapEndpoints = { setupURL, certificateURL, version };
      }
    }

    if (!authURL) {
      console.warn(
        "[Bag] authenticateAccount URL not found in bag, using default auth endpoint",
      );
      return { authURL: defaultAuthURL, sapEndpoints };
    }

    return { authURL: normalizeAuthURL(authURL), sapEndpoints };
  } catch (error) {
    console.warn(
      `[Bag] Failed to fetch/parse bag, using default auth endpoint: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { authURL: defaultAuthURL };
  }
}
