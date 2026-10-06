import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDownloadAction } from '../../src/hooks/useDownloadAction';
import { useToastStore } from '../../src/store/toast';
import { authenticate } from '../../src/apple/authenticate';
import { getDownloadInfo } from '../../src/apple/download';
import { purchaseApp, PurchaseError } from '../../src/apple/purchase';
import type { Account, Software } from '../../src/types';

const mocks = vi.hoisted(() => ({ updateAccount: vi.fn(), fetchTasks: vi.fn() }));
vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../src/hooks/useAccounts', () => ({ useAccounts: () => ({ updateAccount: mocks.updateAccount }) }));
vi.mock('../../src/store/downloads', () => ({
  useDownloadsStore: (selector: (state: { fetchTasks: typeof mocks.fetchTasks }) => unknown) =>
    selector({ fetchTasks: mocks.fetchTasks }),
}));
vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/authenticate', () => ({ authenticate: vi.fn() }));
vi.mock('../../src/apple/download', () => ({ getDownloadInfo: vi.fn() }));
vi.mock('../../src/apple/purchase', async () => ({
  ...await vi.importActual<typeof import('../../src/apple/purchase')>('../../src/apple/purchase'),
  purchaseApp: vi.fn(),
}));

const account: Account = {
  email: 'test@example.com', password: '', appleId: 'test@example.com',
  store: '143465', firstName: 'Test', lastName: 'User', passwordToken: 'token',
  directoryServicesIdentifier: '123', cookies: [], deviceIdentifier: 'aabbccddeeff', pod: '56',
};
const app = { id: 123, name: '免费应用', price: 0 } as Software;
const newCookies = [{ name: 'session', value: 'new-cookie', path: '/', secure: true, httpOnly: true }];

describe('获取许可证会话与确认', () => {
  beforeEach(() => {
    vi.mocked(purchaseApp).mockReset();
    vi.mocked(authenticate).mockReset();
    vi.mocked(getDownloadInfo).mockReset();
    mocks.updateAccount.mockReset().mockResolvedValue(undefined);
    useToastStore.setState({ toasts: [] });
  });

  it('有效登录会话直接购买，不在每次购买前重新认证', async () => {
    vi.mocked(purchaseApp).mockResolvedValue({ updatedCookies: newCookies });
    const { result } = renderHook(useDownloadAction);
    await result.current.acquireLicense(account, app);
    expect(authenticate).not.toHaveBeenCalled();
    expect(getDownloadInfo).not.toHaveBeenCalled();
    expect(mocks.updateAccount).toHaveBeenCalledWith({ ...account, cookies: newCookies });
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ type: 'success' })]);
  });

  it('明确过期时续期一次，并使用新的 token、storefront 和 pod 重新购买', async () => {
    const renewed = { ...account, passwordToken: 'renewed-token', storefront: '143465-19,32', pod: '57' };
    vi.mocked(purchaseApp)
      .mockRejectedValueOnce(new PurchaseError('expired', '1008', true))
      .mockResolvedValueOnce({ updatedCookies: newCookies });
    vi.mocked(authenticate).mockResolvedValue(renewed);
    const { result } = renderHook(useDownloadAction);
    await result.current.acquireLicense(account, app);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(vi.mocked(purchaseApp).mock.calls[1][0]).toEqual(renewed);
    expect(mocks.updateAccount).toHaveBeenLastCalledWith({ ...renewed, cookies: newCookies });
  });

  it('续期要求 2FA 时报告认证错误，不再使用旧 token 购买', async () => {
    vi.mocked(purchaseApp).mockRejectedValue(new PurchaseError('expired', '2034', true));
    vi.mocked(authenticate).mockRejectedValue(new Error('verification required'));
    const { result } = renderHook(useDownloadAction);
    await expect(result.current.acquireLicense(account, app)).rejects.toThrow('verification required');
    expect(purchaseApp).toHaveBeenCalledOnce();
    expect(mocks.updateAccount).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('5002 先用更新的 Cookie 验证可下载，再提示成功', async () => {
    vi.mocked(purchaseApp).mockResolvedValue({ alreadyOwned: true, updatedCookies: newCookies });
    vi.mocked(getDownloadInfo).mockResolvedValue({
      output: {
        downloadURL: 'https://example.test/app.ipa', sinfs: [],
        bundleShortVersionString: '1.0', bundleVersion: '1',
      },
      updatedCookies: [],
    });
    const { result } = renderHook(useDownloadAction);
    await result.current.acquireLicense(account, app);
    expect(getDownloadInfo).toHaveBeenCalledWith({ ...account, cookies: newCookies }, app);
    expect(mocks.updateAccount).toHaveBeenCalledWith(account);
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ type: 'success' })]);
  });

  it('5002 验证仍缺少许可证时保留失败，不产生成功提示', async () => {
    vi.mocked(purchaseApp).mockResolvedValue({ alreadyOwned: true, updatedCookies: newCookies });
    vi.mocked(getDownloadInfo).mockRejectedValue(new Error('license required'));
    const { result } = renderHook(useDownloadAction);
    await expect(result.current.acquireLicense(account, app)).rejects.toThrow('license required');
    expect(authenticate).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('未知错误不触发重复认证或重复购买', async () => {
    vi.mocked(purchaseApp).mockRejectedValue(new PurchaseError('unknown', '9999'));
    const { result } = renderHook(useDownloadAction);
    await expect(result.current.acquireLicense(account, app)).rejects.toThrow('unknown');
    expect(authenticate).not.toHaveBeenCalled();
    expect(purchaseApp).toHaveBeenCalledOnce();
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
