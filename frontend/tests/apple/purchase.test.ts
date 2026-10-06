import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../src/i18n';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import { purchaseApp, PurchaseError } from '../../src/apple/purchase';
import { appleRequest } from '../../src/apple/request';
import type { AppleResponse } from '../../src/apple/request';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));

const account: Account = {
  email: 'test@example.com', password: '', appleId: 'test@example.com',
  store: '143465', storefront: '143465-19,32', firstName: 'Test', lastName: 'User',
  passwordToken: 'test-token', directoryServicesIdentifier: '123', cookies: [],
  deviceIdentifier: 'aabbccddeeff', pod: '56',
};
const app: Software = {
  id: 123, bundleID: 'com.example.free', name: '免费应用', version: '1.0', price: 0,
  artistName: '', sellerName: '', description: '', averageUserRating: 0, userRatingCount: 0,
  artworkUrl: '', screenshotUrls: [], minimumOsVersion: '15.0', releaseDate: '',
};

function reply(dict: Record<string, unknown>, status = 200): AppleResponse {
  return {
    status, statusText: '', body: buildPlist(dict), headers: {},
    rawHeaders: [['Set-Cookie', 'session=new-cookie; Path=/; Domain=itunes.apple.com; Secure']],
  };
}

describe('免费应用许可证协议', () => {
  beforeEach(async () => {
    vi.mocked(appleRequest).mockReset();
    await i18n.changeLanguage('zh-CN');
  });

  it('5002 + 未知错误表示已拥有许可证，交给调用方验证可下载，并保留新 Cookie', async () => {
    vi.mocked(appleRequest).mockResolvedValue(reply({
      failureType: '5002', customerMessage: 'An unknown error has occurred',
    }));
    await expect(purchaseApp(account, app)).resolves.toMatchObject({
      alreadyOwned: true,
      updatedCookies: [expect.objectContaining({ name: 'session', value: 'new-cookie' })],
    });
    expect(appleRequest).toHaveBeenCalledOnce();
  });

  it('使用认证时的完整 storefront、pod 和设备标识符购买', async () => {
    vi.mocked(appleRequest).mockResolvedValue(reply({ jingleDocType: 'purchaseSuccess', status: 0 }));
    await expect(purchaseApp(account, app)).resolves.not.toHaveProperty('alreadyOwned');
    const request = vi.mocked(appleRequest).mock.calls[0][0];
    expect(request.host).toBe('p56-buy.itunes.apple.com');
    expect(request.headers?.['X-Apple-Store-Front']).toBe('143465-19,32');
    expect(parsePlist(request.body!)).toMatchObject({ guid: account.deviceIdentifier, salableAdamId: 123 });
  });

  it.each(['143465', '143465-19,32'])('兼容旧账户 store=%s，完整值不重复追加后缀', async (store) => {
    vi.mocked(appleRequest).mockResolvedValue(reply({ jingleDocType: 'purchaseSuccess', status: 0 }));
    await purchaseApp({ ...account, store, storefront: undefined }, app);
    expect(vi.mocked(appleRequest).mock.calls[0][0].headers?.['X-Apple-Store-Front'])
      .toBe(store.includes('-') ? store : `${store}-1`);
  });

  it.each(['2034', '2042', '1008'])('Apple %s 明确要求重新认证', async (failureType) => {
    vi.mocked(appleRequest).mockResolvedValue(reply({
      failureType, customerMessage: 'An unknown error has occurred',
    }));
    await expect(purchaseApp(account, app)).rejects.toMatchObject({
      code: failureType, authenticationRequired: true,
    });
    expect(appleRequest).toHaveBeenCalledOnce();
  });

  it('其他未知错误保留编号，不能误报许可证成功', async () => {
    vi.mocked(appleRequest).mockResolvedValue(reply({
      failureType: '9999', customerMessage: 'An unknown error has occurred.',
    }));
    const error = await purchaseApp(account, app).catch((error: Error) => error);
    expect(error).toBeInstanceOf(PurchaseError);
    expect((error as Error).message).toContain('Apple 9999; HTTP 200');
    expect(error).toMatchObject({ authenticationRequired: false });
  });

  it.each([reply({}, 500), reply({}, 204), { ...reply({}), body: '<html>private-response</html>' },
    reply({ jingleDocType: 'purchaseSuccess', status: 1 }), reply({}),
  ])('HTTP 错误、空结果和无效响应不会被当成已拥有许可证', async (response) => {
    vi.mocked(appleRequest).mockResolvedValue(response);
    await expect(purchaseApp(account, app)).rejects.toBeInstanceOf(PurchaseError);
    expect(appleRequest).toHaveBeenCalledOnce();
  });

  it('条款提示即使没有 failureType 也必须交给用户处理', async () => {
    const url = 'https://buy.itunes.apple.com/termsPage?store=143465';
    vi.mocked(appleRequest).mockResolvedValue(reply({ action: { URL: url } }));
    await expect(purchaseApp(account, app)).rejects.toThrow(url);
  });

  it('仅 2059 回退到 GAME，普通失败不重试购买', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(reply({ failureType: '2059' }))
      .mockResolvedValueOnce(reply({ jingleDocType: 'purchaseSuccess', status: 0 }));
    await purchaseApp(account, app);
    const pricing = vi.mocked(appleRequest).mock.calls.map(([request]) => parsePlist(request.body!).pricingParameters);
    expect(pricing).toEqual(['STDQ', 'GAME']);
  });

  it('付费应用不会发送购买请求', async () => {
    await expect(purchaseApp(account, { ...app, price: 1 })).rejects.toBeInstanceOf(PurchaseError);
    expect(appleRequest).not.toHaveBeenCalled();
  });
});
