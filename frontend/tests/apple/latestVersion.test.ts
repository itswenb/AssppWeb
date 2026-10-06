import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getLatestVersionId } from '../../src/apple/latestVersion';
import { appleRequest } from '../../src/apple/request';
import type { Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
const app = { id: 123, bundleID: 'com.example.free' } as Software;
const response = (results: Record<string, unknown>) => ({
  status: 200, statusText: '', headers: {}, rawHeaders: [] as [string, string][],
  body: JSON.stringify({ results }),
});
const listing = (offer: Record<string, unknown>) => ({
  '123': { bundleId: app.bundleID, offers: [offer] },
});

describe('按账号地区选择当前 iOS 版本', () => {
  beforeEach(() => { vi.mocked(appleRequest).mockReset(); });

  it.each([['143465', 'cn'], ['143441', 'us'], ['143462', 'jp']])(
    '账号商店 %s 使用 %s 目录，不携带任何账号认证数据', async (store, country) => {
      vi.mocked(appleRequest).mockResolvedValue(response(listing({ version: { externalId: 456 } })));
      await expect(getLatestVersionId(store, app)).resolves.toBe('456');
      const request = vi.mocked(appleRequest).mock.calls[0][0];
      const url = new URL(`https://${request.host}${request.path}`);
      expect(url.searchParams.get('cc')).toBe(country);
      expect(url.searchParams.get('platform')).toBe('enterprisestore');
      expect(request.cookies).toBeUndefined();
      expect(request.body).toBeUndefined();
      expect(request.headers).toEqual({ Accept: 'application/json' });
    },
  );

  it('中国企业目录为空时查询同地区 iPhone 目录，兼容 buyParams 版本号', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response(listing({ buyParams: 'salableAdamId=123&appExtVrsId=789' })));
    await expect(getLatestVersionId('143465-19,32', app)).resolves.toBe('789');
    const params = vi.mocked(appleRequest).mock.calls.map(([request]) =>
      new URL(`https://${request.host}${request.path}`).searchParams);
    expect(params.map((value) => value.get('platform'))).toEqual(['enterprisestore', 'iphone']);
    expect(params.map((value) => value.get('cc'))).toEqual(['cn', 'cn']);
  });

  it('缺失版本号或其他 Bundle ID 都不能作为该应用的版本', async () => {
    vi.mocked(appleRequest).mockResolvedValue(response({
      '123': { bundleId: 'com.example.other', offers: [{ version: { externalId: '456' } }] },
    }));
    await expect(getLatestVersionId('143465', app)).rejects.toThrow();
    expect(appleRequest).toHaveBeenCalledTimes(3);
  });

  it('不认识的账号地区不静默回退到美国商店', async () => {
    await expect(getLatestVersionId('', app)).rejects.toThrow();
    expect(appleRequest).not.toHaveBeenCalled();
  });

  it('目录接口发生 HTTP 错误时停止，不改用其他地区', async () => {
    vi.mocked(appleRequest).mockResolvedValue({ ...response({}), status: 429 });
    await expect(getLatestVersionId('143465', app)).rejects.toThrow('HTTP 429');
    expect(appleRequest).toHaveBeenCalledOnce();
  });
});
