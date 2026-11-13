// Browser (Web Push) notifications on this device (ADR-0012). The server keeps one subscription per browser;
// /sw.js shows them. Works on desktop browsers and Android; on iPhone/iPad only after "Add to Home Screen" (iOS 16.4+).
import { BACKEND, http } from './http';

export type PushState = 'unsupported' | 'ios-install' | 'off-server' | 'denied' | 'off' | 'on';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

async function subscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** What this device can do right now, for the settings switch. */
export async function pushState(): Promise<PushState> {
  if (!supported()) return isIos() && !standalone() ? 'ios-install' : 'unsupported';
  if (BACKEND !== 'server') return 'unsupported';
  const { enabled } = await http<{ enabled: boolean }>('GET', '/push/key');
  if (!enabled) return 'off-server';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && (await subscription()) ? 'on' : 'off';
}

const toKey = (b64: string) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** Ask permission (must run from a click), subscribe this browser and register it for the signed-in person. */
export async function enablePush(): Promise<PushState> {
  const { publicKey } = await http<{ publicKey: string | null }>('GET', '/push/key');
  if (!publicKey) return 'off-server';
  if ((await Notification.requestPermission()) !== 'granted') return Notification.permission === 'denied' ? 'denied' : 'off';
  const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) }));
  const { endpoint, keys } = sub.toJSON();
  await http('POST', '/push/subscribe', { endpoint, keys: { p256dh: keys?.p256dh, auth: keys?.auth } });
  return 'on';
}

/** Stop notifications on this browser (also on sign-out, so a shared computer stops getting someone else's alerts). */
export async function disablePush(): Promise<void> {
  if (!supported() || BACKEND !== 'server') return;
  const sub = await subscription();
  if (!sub) return;
  await http('POST', '/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

export const testPush = () => http<{ delivered: number; simulated: boolean }>('POST', '/push/test', {});
