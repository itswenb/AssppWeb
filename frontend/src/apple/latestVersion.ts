import i18n from '../i18n';
import { appleRequest } from './request';
import { storeIdToCountry } from './config';
import type { Software } from '../types';

// 重下载必须固定到账号所在商店的当前 iOS 版本；公开目录请求不携带账号凭据。
export async function getLatestVersionId(store: string, app: Software): Promise<string> {
  const country = storeIdToCountry(store.split('-')[0]);
  const unavailable = () => new Error(i18n.t('errors.download.missingVersion'));
  if (!country) throw unavailable();

  // 部分地区的企业目录没有条目，而消费者 iPhone/iPad 目录仍有该应用。
  for (const platform of ['enterprisestore', 'iphone', 'ipad']) {
    const params = new URLSearchParams({
      version: '2', id: String(app.id), p: 'mdm-lockup', caller: 'MDM',
      platform, cc: country.toLowerCase(), l: 'en',
    });
    const response = await appleRequest({
      method: 'GET', host: 'uclient-api.itunes.apple.com',
      path: `/WebObjects/MZStorePlatform.woa/wa/lookup?${params}`,
      headers: { Accept: 'application/json' },
    });
    if (response.status !== 200) {
      throw new Error(`${i18n.t('errors.download.missingVersion')} (HTTP ${response.status})`);
    }
    let dict: Record<string, any>;
    try {
      dict = JSON.parse(response.body);
    } catch {
      throw unavailable();
    }
    const item = dict?.results?.[String(app.id)];
    if (!item || (app.bundleID && item.bundleId !== app.bundleID)) continue;
    const offer = item.offers?.[0];
    if (!offer) continue;
    const versionId = String(offer.version?.externalId ??
      new URLSearchParams(offer.buyParams ?? '').get('appExtVrsId') ?? '');
    if (/^[1-9]\d*$/.test(versionId)) return versionId;
  }
  throw unavailable();
}
