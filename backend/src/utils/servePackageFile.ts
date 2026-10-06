import type { Response } from 'express';

// sendFile 处理 Range、If-Range、HEAD、条件请求及客户端中断，避免 iOS 续传时重复传整个 IPA。
export function servePackageFile(res: Response, filePath: string): void {
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Cache-Control', 'private, no-transform');
  res.sendFile(filePath, { acceptRanges: true, cacheControl: false }, (error) => {
    if (!error) return;
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const status = 'statusCode' in error ? Number(error.statusCode) : 500;
    res.status(Number.isInteger(status) && status >= 400 && status < 600 ? status : 500).end();
  });
}
