import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import QRCode from 'qrcode';

export function registerQrImagePath(root, subject) {
  return join(root, 'runtime', 'subjects', subject, 'data', 'channel', 'feishu-register-qr.png');
}

export async function renderRegisterQrArtifacts(url, options = {}) {
  const artifacts = {
    url,
    terminal: null,
    imagePath: null,
  };
  if (!options.noQr) {
    artifacts.terminal = await QRCode.toString(url, {
      type: 'terminal',
      small: true,
      errorCorrectionLevel: 'M',
    });
  }
  if (!options.noQrImage && options.imagePath) {
    mkdirSync(dirname(options.imagePath), { recursive: true });
    await QRCode.toFile(options.imagePath, url, {
      width: 400,
      margin: 2,
      errorCorrectionLevel: 'M',
    });
    artifacts.imagePath = options.imagePath;
  }
  return artifacts;
}

export function openImageFile(filePath) {
  if (!filePath) return false;
  let cmd;
  let args;
  if (process.platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = [filePath];
  } else {
    cmd = 'xdg-open';
    args = [filePath];
  }
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  return true;
}

export async function printRegisterQrPrompt(info, options = {}) {
  const url = info?.url;
  const expireIn = info?.expireIn;
  if (!url) throw new Error('register QR url missing');

  console.log('\n=== 飞书应用注册 ===');
  console.log('请用飞书 App 扫描下方二维码，或打开链接完成授权：');
  console.log(url);
  console.log(`授权链接将在 ${expireIn} 秒后过期`);

  const imagePath = options.subject && options.root && !options.noQrImage
    ? registerQrImagePath(options.root, options.subject)
    : null;

  const artifacts = await renderRegisterQrArtifacts(url, {
    noQr: options.noQr,
    noQrImage: options.noQrImage,
    imagePath,
  });

  if (artifacts.terminal) {
    console.log('\n二维码（终端）：');
    console.log(artifacts.terminal);
  }

  if (artifacts.imagePath) {
    console.log(`\n二维码图片: ${artifacts.imagePath}`);
    if (options.openQr !== false) {
      openImageFile(artifacts.imagePath);
      console.log('已尝试用系统默认图片查看器打开二维码。');
    }
  }

  console.log('\n等待授权中...\n');
  return artifacts;
}
