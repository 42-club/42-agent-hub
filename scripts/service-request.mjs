import { serviceUrl } from './runtime-config.mjs';

export class ServiceRequestError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// Server-side Service calls only. Never use the Hub project's own Vercel secret
// as a fallback: the bypass credential must belong to the destination project.
/** @param {string} path @param {RequestInit} [init] */
export async function serviceRequest(path, init = {}) {
  const headers = new Headers(init.headers);
  const bypass = process.env.CLUB_SERVICE_PROTECTION_BYPASS?.trim();
  if (bypass) headers.set('x-vercel-protection-bypass', bypass);
  const response = await fetch(`${serviceUrl()}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
    redirect: 'manual',
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new ServiceRequestError('redirect', '共享服务返回了重定向，请检查服务地址和部署保护配置。');
  }
  const text = await response.text();
  if (!text && response.ok) return { response, data: null };
  if (!/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
    throw new ServiceRequestError('response', '共享服务返回了非 JSON 响应，请检查服务地址和部署保护配置。');
  }
  let data;
  try { data = JSON.parse(text); }
  catch { throw new ServiceRequestError('response', '共享服务返回了无效的 JSON 响应，请稍后重试。'); }
  if (!response.ok && data?.message === 'Protected by Vercel Authentication') {
    throw new ServiceRequestError('protection', '共享服务的 Vercel 部署保护拒绝访问，请检查 Service 的自动化访问凭证。');
  }
  return { response, data };
}
