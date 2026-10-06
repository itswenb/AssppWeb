import i18n from '../i18n';
import { appleRequest } from './request';
import { buildPlist, parsePlist } from './plist';
import { extractAndMergeCookies } from './cookies';
import { purchaseAPIHost } from './config';
import type { Account, Software } from '../types';

export class PurchaseError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly authenticationRequired: boolean = false,
  ) {
    super(message);
    this.name = 'PurchaseError';
  }
}

export async function purchaseApp(
  account: Account,
  app: Software,
): Promise<{ updatedCookies: typeof account.cookies; alreadyOwned?: boolean }> {
  if ((app.price ?? 0) > 0) {
    throw new PurchaseError(i18n.t('errors.purchase.paidNotSupported'));
  }

  try {
    return await purchaseWithParams(account, app, 'STDQ');
  } catch (e) {
    // 按 Apple 错误码重试，不依赖翻译后的消息。
    if (e instanceof PurchaseError && e.code === '2059') {
      return await purchaseWithParams(account, app, 'GAME');
    }
    throw e;
  }
}

async function purchaseWithParams(
  account: Account,
  app: Software,
  pricingParameters: string,
): Promise<{ updatedCookies: typeof account.cookies; alreadyOwned?: boolean }> {
  const deviceId = account.deviceIdentifier;
  const host = purchaseAPIHost(account.pod);
  const path = '/WebObjects/MZFinance.woa/wa/buyProduct';

  const payload: Record<string, any> = {
    appExtVrsId: '0',
    hasAskedToFulfillPreorder: 'true',
    buyWithoutAuthorization: 'true',
    hasDoneAgeCheck: 'true',
    guid: deviceId,
    needDiv: '0',
    origPage: `Software-${app.id}`,
    origPageLocation: 'Buy',
    price: '0',
    pricingParameters,
    productType: 'C',
    salableAdamId: app.id,
  };

  const plistBody = buildPlist(payload);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-apple-plist',
    'iCloud-DSID': account.directoryServicesIdentifier,
    'X-Dsid': account.directoryServicesIdentifier,
    'X-Apple-Store-Front': account.storefront ||
      (account.store.includes('-') ? account.store : `${account.store}-1`),
    'X-Token': account.passwordToken,
  };

  const response = await appleRequest({
    method: 'POST',
    host,
    path,
    headers,
    body: plistBody,
    cookies: account.cookies,
  });

  const updatedCookies = extractAndMergeCookies(
    response.rawHeaders,
    account.cookies,
  );

  // HTTP 错误或非 plist 响应不能作为已获取许可证的证据。
  const invalidResponse = () => new PurchaseError(
    `${i18n.t('errors.purchase.failedGeneral')} (HTTP ${response.status}; ${host}${path})`,
  );
  if (response.status !== 200) {
    throw invalidResponse();
  }
  let dict: Record<string, any>;
  try {
    dict = parsePlist(response.body) as Record<string, any>;
  } catch {
    throw invalidResponse();
  }
  if (!dict || typeof dict !== 'object' || Array.isArray(dict)) {
    throw invalidResponse();
  }

  // 条款提示可能没有 failureType，仍需明确交给用户处理。
  const actionUrl = (dict.action?.url || dict.action?.URL) as string | undefined;
  if (actionUrl && actionUrl.split('?')[0].endsWith('termsPage')) {
    throw new PurchaseError(
      i18n.t('errors.purchase.termsRequired', { url: actionUrl }),
      dict.failureType ? String(dict.failureType) : undefined,
    );
  }

  if (dict.failureType) {
    const failureType = String(dict.failureType);
    const customerMessage = dict.customerMessage as string | undefined;
    switch (failureType) {
      case '5002':
        // Apple 对已拥有的免费应用也会返回“An unknown error has occurred”。
        return { updatedCookies, alreadyOwned: true };
      case '2059':
        throw new PurchaseError(i18n.t('errors.purchase.unavailable'), '2059');
      case '2034':
      case '2042':
      case '1008':
        throw new PurchaseError(
          i18n.t('errors.purchase.passwordExpired'),
          failureType,
          true,
        );
      default: {
        if (customerMessage === 'Your password has changed.') {
          throw new PurchaseError(
            i18n.t('errors.purchase.passwordExpired'),
            failureType,
            true,
          );
        }
        if (customerMessage === 'Subscription Required') {
          throw new PurchaseError(
            i18n.t('errors.purchase.subscriptionRequired'),
            failureType,
          );
        }
        // 保留 Apple 错误码，避免所有账户/地区错误都只显示“未知错误”。
        let msg = customerMessage;
        if (
          msg === 'An unknown error has occurred' ||
          msg === 'An unknown error has occurred.'
        ) {
          msg = `${i18n.t('errors.purchase.unknownError')} (Apple ${failureType}; HTTP ${response.status})`;
        }

        throw new PurchaseError(
          msg ?? i18n.t('errors.purchase.failed', { failureType }),
          failureType,
        );
      }
    }
  }

  const jingleDocType = dict.jingleDocType as string | undefined;
  const status = dict.status as number | undefined;

  if (jingleDocType !== 'purchaseSuccess' || status !== 0) {
    throw invalidResponse();
  }

  return { updatedCookies };
}
