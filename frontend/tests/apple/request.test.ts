import { beforeEach, describe, expect, it, vi } from 'vitest';
import { libcurl } from '../../src/apple/libcurl-init';
import { appleRequest } from '../../src/apple/request';

const { sessionFetch, close, createSession } = vi.hoisted(() => ({
  sessionFetch: vi.fn(),
  close: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock('../../src/apple/libcurl-init', () => ({
  initLibcurl: vi.fn(),
  libcurl: {
    fetch: vi.fn(),
    HTTPSession: class {
      fetch = sessionFetch;
      close = close;
      constructor() { createSession(); }
    },
  },
}));

const options = {
  host: 'buy.itunes.apple.com',
  path: '/auth?guid=aabbccddeeff',
  method: 'POST',
  body: '<plist>密码 &amp; 2FA</plist>',
  headers: { 'X-Apple-ActionSignature': 'signature' },
  cookies: [{ name: 'session', value: 'retained', path: '/' }],
};

describe('apple/request 认证连接', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    sessionFetch.mockResolvedValue({
      status: 200, statusText: 'OK', raw_headers: [], text: async () => 'response',
    });
  });

  it('每个认证请求创建独立会话，读完正文后关闭，保留 Cookie 和签名字节', async () => {
    await appleRequest({ ...options, freshConnection: true });
    await appleRequest({ ...options, freshConnection: true });
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(libcurl.fetch).not.toHaveBeenCalled();
    expect(sessionFetch).toHaveBeenCalledWith('https://buy.itunes.apple.com/auth?guid=aabbccddeeff',
      expect.objectContaining({
        body: options.body, redirect: 'manual', _libcurl_http_version: 1.1,
        headers: expect.objectContaining({ Cookie: 'session=retained', 'X-Apple-ActionSignature': 'signature' }),
      }));
  });

  it.each(['fetch', 'body'])('在 %s 失败时也关闭会话', async (stage) => {
    const error = new Error('SSL connect error');
    if (stage === 'fetch') {
      sessionFetch.mockRejectedValue(error);
    } else {
      sessionFetch.mockResolvedValue({ raw_headers: [], text: async () => { throw error; } });
    }
    await expect(appleRequest({ ...options, freshConnection: true })).rejects.toBe(error);
    expect(close).toHaveBeenCalledOnce();
  });

  it('普通 Apple 请求继续使用共享连接池', async () => {
    vi.mocked(libcurl.fetch).mockResolvedValue({
      status: 200, statusText: 'OK', raw_headers: [], text: async () => 'response',
    } as any);
    await appleRequest(options);
    expect(createSession).not.toHaveBeenCalled();
    expect(libcurl.fetch).toHaveBeenCalledOnce();
  });
});
