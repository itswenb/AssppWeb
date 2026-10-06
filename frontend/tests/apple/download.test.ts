import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../../src/i18n';
import { getDownloadInfo, DownloadError } from '../../src/apple/download';
import { getLatestVersionId } from '../../src/apple/latestVersion';
import { buildPlist, parsePlist } from '../../src/apple/plist';
import { appleRequest } from '../../src/apple/request';
import type { AppleResponse } from '../../src/apple/request';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/latestVersion', () => ({ getLatestVersionId: vi.fn() }));
const account: Account = {
  email: 'test@example.com', password: '', appleId: 'test@example.com',
  store: '143465', firstName: '', lastName: '', passwordToken: 'test-token',
  directoryServicesIdentifier: '123', cookies: [], deviceIdentifier: 'aabbccddeeff', pod: '56',
};
const app = { id: 123, bundleID: 'com.example.free' } as Software;
const success = {
  songList: [{ URL: 'https://example.test/app.ipa',
    metadata: { bundleShortVersionString: '1.0', bundleVersion: '1' },
    sinfs: [{ id: 1, sinf: 'dGVzdA==' }],
  }],
};
function response(dict: Record<string, unknown>, status = 200): AppleResponse {
  return { status, statusText: '', headers: {}, body: buildPlist(dict),
    rawHeaders: [['Set-Cookie', 'session=updated-cookie; Path=/; Domain=itunes.apple.com; Secure']],
  };
}

describe('Apple 空下载列表恢复', () => {
  beforeEach(async () => {
    vi.mocked(appleRequest).mockReset();
    vi.mocked(getLatestVersionId).mockReset().mockResolvedValue('456');
    await i18n.changeLanguage('zh-CN');
  });

  it('HTTP 200 空 songList 转向重下载，固定所选账号地区的 iOS 版本并保留 Cookie', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response({ jingleDocType: 'purchaseSuccess', status: 0, authorized: false, songList: [] }))
      .mockResolvedValueOnce(response(success));
    await expect(getDownloadInfo(account, app)).resolves.toMatchObject({ output: { downloadURL: 'https://example.test/app.ipa' } });
    expect(getLatestVersionId).toHaveBeenCalledWith('143465', app);
    const [initial, retry] = vi.mocked(appleRequest).mock.calls.map(([request]) => request);
    expect(initial.host).toBe('p56-buy.itunes.apple.com');
    expect(retry.host).toBe('downloaddispatch.itunes.apple.com');
    expect(parsePlist(retry.body!)).toMatchObject({ appExtVrsId: '456', serialNumber: '0' });
    expect(retry.cookies).toEqual([expect.objectContaining({ value: 'updated-cookie' })]);
  });

  it('历史版本请求切换端点时保留指定版本，不查询或覆盖为最新版本', async () => {
    vi.mocked(appleRequest)
      .mockResolvedValueOnce(response({ songList: [] }))
      .mockResolvedValueOnce(response(success));
    await getDownloadInfo(account, app, '111');
    expect(getLatestVersionId).not.toHaveBeenCalled();
    expect(parsePlist(vi.mocked(appleRequest).mock.calls[0][0].body!).externalVersionId).toBe('111');
    expect(parsePlist(vi.mocked(appleRequest).mock.calls[1][0].body!).appExtVrsId).toBe('111');
  });

  it('5002 和无错误码的不可用响应也只切换一次', async () => {
    for (const dict of [{ failureType: '5002' }, { customerMessage: 'Item No Longer Available' }]) {
      vi.mocked(appleRequest).mockReset()
        .mockResolvedValueOnce(response(dict))
        .mockResolvedValueOnce(response(success));
      await getDownloadInfo(account, app);
      expect(appleRequest).toHaveBeenCalledTimes(2);
    }
  });

  it('重下载仍为空时停止，错误只包含状态和路径，不含账号、Cookie、guid 或响应正文', async () => {
    vi.mocked(appleRequest).mockResolvedValue(response({ songList: [], privateField: 'private-response' }));
    const error = await getDownloadInfo(account, app).catch((error: Error) => error);
    expect(error).toBeInstanceOf(DownloadError);
    expect((error as Error).message).toContain('HTTP 200; downloaddispatch.itunes.apple.com/r/redownload');
    for (const secret of [account.email, account.passwordToken, account.deviceIdentifier, 'updated-cookie', 'private-response']) {
      expect((error as Error).message).not.toContain(secret);
    }
    expect(appleRequest).toHaveBeenCalledTimes(2);
  });

  it.each([
    response({ failureType: '9610' }), response({ failureType: '2034' }),
    response({ songList: [] }, 500), response({ songList: [] }, 429),
    response({ customerMessage: 'Subscription Required' }),
  ])('许可证、认证和 HTTP 错误不会被空列表恢复吞掉', async (reply) => {
    vi.mocked(appleRequest).mockResolvedValue(reply);
    await expect(getDownloadInfo(account, app)).rejects.toBeInstanceOf(DownloadError);
    expect(appleRequest).toHaveBeenCalledOnce();
    expect(getLatestVersionId).not.toHaveBeenCalled();
  });
});
