import i18n from '../i18n';
import { appleRequest } from './request';
import { buildPlist, parsePlist } from './plist';
import { extractAndMergeCookies } from './cookies';
import { fetchBag, normalizeAuthURL } from './bag';
import { prepareSigner } from './sap/client';
import type { Account, Cookie } from '../types';

const MAX_REQUEST_ATTEMPTS = 3;
const MAX_REDIRECTS = 3;
const MAX_RETRY_DELAY_MS = 30_000;

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired: boolean = false,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

function authenticationRetryDelay(value: string | undefined, attempt: number): number {
  const header = value?.trim() ?? '';
  if (/^\d+$/.test(header)) {
    return Math.max(1_000, Number(header) * 1_000);
  }
  const deadline = header.includes('GMT') ? Date.parse(header) : NaN;
  if (Number.isFinite(deadline)) {
    return Math.max(1_000, deadline - Date.now());
  }
  return attempt * 10_000;
}

export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId: string = '',
): Promise<Account> {
  let cookies: Cookie[] = existingCookies ? [...existingCookies] : [];
  let storeFront = '';
  let storefront: string | undefined;
  let pod: string | undefined;

  const bag = await fetchBag(deviceId);
  const authEndpoint = new URL(normalizeAuthURL(bag.authURL));
  authEndpoint.searchParams.set('guid', deviceId);
  let requestHost = authEndpoint.hostname;
  let requestPath = `${authEndpoint.pathname}${authEndpoint.search}`;

  // SAP 会话跨重试、重定向和 2FA 复用；每次请求签名覆盖实际发送的 UTF-8 字节。
  const sapSigner = bag.sapEndpoints
    ? await prepareSigner(deviceId, bag.sapEndpoints)
    : null;
  const plistBody = buildPlist({
    appleId: email,
    attempt: code ? '2' : '4',
    guid: deviceId,
    password: code ? `${password}${code}` : password,
    rmp: '0',
    why: 'signIn',
  });

  let requestAttempt = 0;
  let redirectAttempt = 0;
  const statuses: number[] = [];

  while (true) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-apple-plist',
    };
    if (sapSigner) {
      headers['X-Apple-ActionSignature'] = await sapSigner.sign(
        new TextEncoder().encode(plistBody),
      );
    }

    const response = await appleRequest({
      method: 'POST',
      host: requestHost,
      path: requestPath,
      headers,
      body: plistBody,
      cookies,
      freshConnection: true,
    });
    requestAttempt++;
    statuses.push(response.status);
    cookies = extractAndMergeCookies(response.rawHeaders, cookies);

    const storeHeader = response.headers['x-set-apple-store-front'];
    if (storeHeader) {
      const parts = storeHeader.split('-');
      if (parts[0]) {
        storeFront = parts[0];
        storefront = storeHeader;
      }
    }
    // Apple 可能只在重定向中返回 pod；最终响应没有该头时保留路由。
    pod = response.headers['pod'] || requestHost.match(/^p(\d+)-buy\.itunes\.apple\.com$/)?.[1] || pod;

    // 诊断仅包含域名、路径和状态，不记录请求体、查询参数或 Cookie。
    const endpoint = `${requestHost}${requestPath.split('?')[0]}`;
    const unexpectedResponse = () => new AuthenticationError(
      i18n.t('errors.auth.unexpectedResponse', {
        statuses: statuses.join(' → '),
        endpoint,
      }),
    );

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers['location'];
      if (!location) {
        throw new AuthenticationError(
          `${i18n.t('errors.auth.redirectLocation')} (${endpoint}; HTTP ${response.status})`,
        );
      }
      if (redirectAttempt >= MAX_REDIRECTS) {
        throw new AuthenticationError(i18n.t('errors.auth.tooManyRedirects'));
      }
      const redirectURL = new URL(location, `https://${requestHost}${requestPath}`);
      const url = new URL(normalizeAuthURL(redirectURL.toString()));
      requestHost = url.hostname;
      requestPath = url.pathname + url.search;
      redirectAttempt++;
      requestAttempt = 0;
      continue;
    }

    let dict: Record<string, any> | null = null;
    if (response.body.trim()) {
      try {
        const parsed = parsePlist(response.body);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          dict = parsed;
        }
      } catch {
        // Apple 边缘节点可能返回空响应或 HTML；不能当作账户认证结果。
      }
    }

    if (!dict) {
      const retryable = response.status === 204 || response.status === 404 ||
        response.status === 429 || (response.status >= 500 && response.status <= 599);
      if (!retryable || requestAttempt >= MAX_REQUEST_ATTEMPTS) {
        throw unexpectedResponse();
      }
      const delay = authenticationRetryDelay(response.headers['retry-after'], requestAttempt);
      if (delay > MAX_RETRY_DELAY_MS) {
        throw new AuthenticationError(i18n.t('errors.auth.retryLater', {
          endpoint,
          status: response.status,
        }));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      continue;
    }

    if (
      dict.failureType === '' &&
      !code &&
      dict.customerMessage === 'MZFinance.BadLogin.Configurator_message'
    ) {
      throw new AuthenticationError(i18n.t('errors.auth.requiresVerification'), true);
    }

    const failureMessage =
      (dict.dialog as Record<string, any>)?.explanation ?? dict.customerMessage;
    const accountInfo = dict.accountInfo as Record<string, any>;
    if (!accountInfo) {
      throw new AuthenticationError(failureMessage ?? i18n.t('errors.auth.missingAccountInfo'));
    }
    if (response.status !== 200) {
      throw unexpectedResponse();
    }
    const address = accountInfo.address as Record<string, any>;
    if (!address) {
      throw new AuthenticationError(failureMessage ?? i18n.t('errors.auth.missingAddress'));
    }

    return {
      email,
      password,
      appleId: (accountInfo.appleId as string) ?? '',
      store: storeFront,
      storefront,
      firstName: (address.firstName as string) ?? '',
      lastName: (address.lastName as string) ?? '',
      passwordToken: (dict.passwordToken as string) ?? '',
      directoryServicesIdentifier: String(dict.dsPersonId ?? ''),
      cookies,
      deviceIdentifier: deviceId,
      pod,
    };
  }
}
