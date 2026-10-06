import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../src/i18n';
import { authenticate, AuthenticationError } from '../../src/apple/authenticate';
import { fetchBag } from '../../src/apple/bag';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import { appleRequest } from '../../src/apple/request';
import { prepareSigner } from '../../src/apple/sap/client';
import type { AppleResponse } from '../../src/apple/request';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/bag', async () => ({
  ...await vi.importActual<typeof import('../../src/apple/bag')>('../../src/apple/bag'),
  fetchBag: vi.fn(),
}));
vi.mock('../../src/apple/sap/client', () => ({ prepareSigner: vi.fn() }));

const authURL = 'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate';
const successBody = buildPlist({
  accountInfo: { appleId: 'test@example.com', address: { firstName: 'Test', lastName: 'User' } },
  passwordToken: 'password-token', dsPersonId: '123',
});
const challengeBody = buildPlist({
  failureType: '', customerMessage: 'MZFinance.BadLogin.Configurator_message',
});
const sign = vi.fn(async (body: Uint8Array) => btoa(String.fromCharCode(...body)));

function response(status: number, body = '', headers: Record<string, string> = {},
  rawHeaders: [string, string][] = []): AppleResponse {
  return { status, statusText: '', body, headers, rawHeaders };
}

function login(code?: string) {
  return authenticate('test@example.com', '密<&码', code, undefined, 'aabbccddeeff');
}

describe('Apple 认证异常响应恢复', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
    vi.mocked(appleRequest).mockReset();
    vi.mocked(fetchBag).mockReset().mockResolvedValue({
      authURL,
      sapEndpoints: {
        certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist',
        setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
        version: 200,
      },
    });
    sign.mockClear();
    vi.mocked(prepareSigner).mockReset().mockResolvedValue({ sign } as any);
    await i18n.changeLanguage('en-US');
  });

  afterEach(() => { vi.useRealTimers(); });

  it('204 后等待 10/20 秒再请求，最多三次，签名始终覆盖实际发送的 UTF-8 字节', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(200, successBody));
    const done = expect(login()).resolves.toMatchObject({ passwordToken: 'password-token' });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(appleRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(appleRequest).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(appleRequest).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(prepareSigner).toHaveBeenCalledOnce();
    const bodies = vi.mocked(appleRequest).mock.calls.map(([request]) => request.body);
    expect(new Set(bodies).size).toBe(1);
    for (const [index, [request]] of vi.mocked(appleRequest).mock.calls.entries()) {
      expect(new URL(`https://${request.host}${request.path}`).pathname)
        .toBe('/WebObjects/MZFinance.woa/wa/authenticate/');
      const bytes = new TextEncoder().encode(request.body);
      expect(sign.mock.calls[index][0]).toEqual(bytes);
      expect(request.headers?.['X-Apple-ActionSignature']).toBe(btoa(String.fromCharCode(...bytes)));
      expect(request.freshConnection).toBe(true);
      expect(parsePlist(request.body!).attempt).toBe('4');
    }
  });

  it('耗尽重试后提供状态历史和端点，不泄露邮箱、密码、guid、Cookie 或 HTML 正文', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response(204, '', {}, [['Set-Cookie', 'session=private-cookie; Path=/']]))
      .mockResolvedValueOnce(response(404, '<html>private-response</html>'))
      .mockResolvedValueOnce(response(503));
    const result = login().catch((error: Error) => error);
    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).toBeInstanceOf(AuthenticationError);
    const message = (error as Error).message;
    expect(message).toContain('204 → 404 → 503');
    expect(message).toContain('buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate');
    for (const secret of ['test@example.com', '密<&码', 'aabbccddeeff', 'private-cookie', 'private-response']) {
      expect(message).not.toContain(secret);
    }
    expect(appleRequest).toHaveBeenCalledTimes(3);
  });

  it('pod 重定向重置重试预算，保留 Cookie、storefront 和 2FA 签名', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response(204, '', {}, [['Set-Cookie', 'session=retained; Path=/; Domain=itunes.apple.com']]))
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(302, '', {
        location: 'https://p7-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?guid=aabbccddeeff',
        'x-set-apple-store-front': '143441-1,29',
      }))
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(200, successBody, { pod: '7' }))
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(200, successBody, { pod: '7' }));
    const done = expect(login()).resolves.toMatchObject({ store: '143441', pod: '7' });
    await vi.runAllTimersAsync();
    await done;
    expect(appleRequest).toHaveBeenCalledTimes(6);
    const requests = vi.mocked(appleRequest).mock.calls.map(([request]) => request);
    expect(requests[1].cookies).toEqual([expect.objectContaining({ name: 'session', value: 'retained' })]);
    for (const request of requests.slice(3)) {
      expect(request.cookies).toEqual(requests[1].cookies);
      expect(request.host).toBe('p7-buy.itunes.apple.com');
      expect(request.path).toBe('/WebObjects/MZFinance.woa/wa/authenticate/?guid=aabbccddeeff');
      expect(request.body).toBe(requests[0].body);
    }

    const verified = expect(authenticate('test@example.com', '密<&码', '123456', requests[5].cookies, 'aabbccddeeff'))
      .resolves.toMatchObject({ pod: '7' });
    await vi.runAllTimersAsync();
    await verified;
    const verification = vi.mocked(appleRequest).mock.calls[7][0];
    expect(parsePlist(verification.body!)).toMatchObject({ password: '密<&码123456', attempt: '2' });
    expect(sign.mock.calls[7][0]).toEqual(new TextEncoder().encode(verification.body));
    expect(verification.cookies).toEqual(requests[5].cookies);
    expect(vi.mocked(appleRequest).mock.calls[6][0].body).toBe(verification.body);
  });

  it('收到有效 2FA 挑战后立即交给用户输入验证码', async () => {
    vi.mocked(appleRequest).mockResolvedValue(response(200, challengeBody));
    await expect(login()).rejects.toMatchObject({ codeRequired: true });
    expect(appleRequest).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['5', 5_000], ['0', 1_000], ['invalid', 10_000], ['-1', 10_000],
    ['Wed, 07 Oct 2026 10:00:05 GMT', 5_000], ['Wed, 07 Oct 2026 09:59:59 GMT', 1_000],
  ])('429 遵守 Retry-After %s，等待 %i ms', async (header, delay) => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response(429, '', { 'retry-after': header }))
      .mockResolvedValueOnce(response(200, successBody));
    const done = expect(login()).resolves.toMatchObject({ directoryServicesIdentifier: '123' });
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(appleRequest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await done;
  });

  it.each(['3600', '99999999999999999999', 'Wed, 07 Oct 2026 10:01:00 GMT'])(
    'Apple 要求等待 %s 时停止自动重试', async (header) => {
      vi.mocked(appleRequest).mockResolvedValue(response(503, '', { 'retry-after': header }));
      await expect(login()).rejects.toThrow('longer than 30 seconds');
      expect(appleRequest).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    response(403),
    response(200, buildPlist({ failureType: '5001', customerMessage: 'Invalid credentials' })),
    response(503, buildPlist({ failureType: '5001', customerMessage: 'Invalid credentials' })),
    response(200, '<html>unusable-response</html>'),
    response(302),
  ])('有效账户错误、不可重试状态和缺少 Location 不重复登录：%j', async (reply) => {
    vi.mocked(appleRequest).mockResolvedValue(reply);
    await expect(login()).rejects.toBeInstanceOf(AuthenticationError);
    expect(appleRequest).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('限制重定向次数，避免反复发送凭据', async () => {
    vi.mocked(appleRequest).mockResolvedValue(response(302, '', { location: authURL }));
    await expect(login()).rejects.toThrow('Too many authentication redirects');
    expect(appleRequest).toHaveBeenCalledTimes(4);
  });

  it('保留正常 301 的 Location 查询参数，并规范化 pod 的认证路径', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response(301, '', {
        location: 'https://p7-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?Pod=7&PRH=7',
      }))
      .mockResolvedValueOnce(response(200, successBody));
    await expect(login()).resolves.toMatchObject({ passwordToken: 'password-token' });
    const [first, next] = vi.mocked(appleRequest).mock.calls.map(([request]) => request);
    expect(next.host).toBe('p7-buy.itunes.apple.com');
    expect(next.path).toBe('/WebObjects/MZFinance.woa/wa/authenticate/?Pod=7&PRH=7');
    expect(next.body).toBe(first.body);
    expect(next.headers?.['X-Apple-ActionSignature']).toBe(first.headers?.['X-Apple-ActionSignature']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('没有 SAP 参数时也能恢复 204，不启动签名组件', async () => {
    vi.mocked(fetchBag).mockResolvedValue({ authURL });
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(200, successBody));
    const done = expect(login()).resolves.toMatchObject({ appleId: 'test@example.com' });
    await vi.runAllTimersAsync();
    await done;
    expect(prepareSigner).not.toHaveBeenCalled();
  });
});
