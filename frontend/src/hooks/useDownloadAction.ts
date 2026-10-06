import { useTranslation } from 'react-i18next';
import { useAccounts } from './useAccounts';
import { useToastStore } from '../store/toast';
import { useDownloadsStore } from '../store/downloads';
import { getDownloadInfo } from '../apple/download';
import { purchaseApp, PurchaseError } from '../apple/purchase';
import { authenticate } from '../apple/authenticate';
import { apiPost, apiGet } from '../api/client';
import { accountHash } from '../utils/account';
import { getErrorMessage } from '../utils/error';
import { getAccountContext } from '../utils/toast';
import type { Account, Software } from '../types';

/**
 * Shared hook for download & purchase actions.
 * Eliminates the duplicated flow across ProductDetail, VersionHistory, and AddDownload.
 */
export function useDownloadAction() {
  const { updateAccount } = useAccounts();
  const addToast = useToastStore((s) => s.addToast);
  const fetchTasks = useDownloadsStore((s) => s.fetchTasks);
  const { t } = useTranslation();

  async function startDownload(
    account: Account,
    app: Software,
    versionId?: string,
  ) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;

    try {
      const settings = await apiGet<{ maxDownloadMB: number }>('/api/settings');
      if (settings.maxDownloadMB > 0 && app.fileSizeBytes) {
        const sizeMB = parseInt(app.fileSizeBytes, 10) / (1024 * 1024);
        if (sizeMB > settings.maxDownloadMB) {
          addToast(
            t('toast.downloadLimit.message', {
              appName,
              size: sizeMB.toFixed(2),
              limit: settings.maxDownloadMB,
            }),
            'error',
            t('toast.title.downloadLimit'),
          );
          return;
        }
      }
    } catch {
      // Settings fetch failed — backend will still enforce the limit
    }

    const { output, updatedCookies } = await getDownloadInfo(
      account,
      app,
      versionId,
    );
    await updateAccount({ ...account, cookies: updatedCookies });
    const hash = await accountHash(account);

    await apiPost('/api/downloads', {
      software: { ...app, version: output.bundleShortVersionString },
      accountHash: hash,
      downloadURL: output.downloadURL,
      sinfs: output.sinfs,
      iTunesMetadata: output.iTunesMetadata,
    });

    fetchTasks();

    addToast(
      t('toast.msg', { appName, ...ctx }),
      'info',
      t('toast.title.downloadStarted'),
    );
  }

  async function acquireLicense(account: Account, app: Software) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;

    // 先使用已登录会话；只有 Apple 明确要求重新认证时才续期一次。
    let currentAccount = account;
    let result;
    try {
      result = await purchaseApp(currentAccount, app);
    } catch (error) {
      if (!(error instanceof PurchaseError) || !error.authenticationRequired) {
        throw error;
      }
      const renewed = await authenticate(
        account.email,
        account.password,
        undefined,
        account.cookies,
        account.deviceIdentifier,
      );
      await updateAccount(renewed);
      currentAccount = renewed;
      result = await purchaseApp(currentAccount, app);
    }
    // 5002 可能出现在跨区账户中；验证 Apple 确实允许下载，再提示许可证可用。
    let cookies = result.updatedCookies;
    if (result.alreadyOwned) {
      const verified = await getDownloadInfo({ ...currentAccount, cookies }, app);
      cookies = verified.updatedCookies;
    }
    await updateAccount({ ...currentAccount, cookies });

    addToast(
      t('toast.msg', { appName, ...ctx }),
      'success',
      t('toast.title.licenseSuccess'),
    );
  }

  function toastDownloadError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t('toast.msgFailed', {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t('toast.title.downloadFailed')),
      }),
      'error',
      t('toast.title.downloadFailed'),
    );
  }

  function toastLicenseError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t('toast.msgFailed', {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t('toast.title.licenseFailed')),
      }),
      'error',
      t('toast.title.licenseFailed'),
    );
  }

  return {
    startDownload,
    acquireLicense,
    toastDownloadError,
    toastLicenseError,
  };
}
