/** Integración nativa Android (Capacitor) con alternativas para el navegador durante el desarrollo. */
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';

export const isNative = Capacitor.isNativePlatform();

let nativeReady = false;

/** Prepara la barra de estado, el botón Atrás y el splash. Es idempotente (React StrictMode monta dos veces en desarrollo). */
export async function initNative(onBack: () => boolean) {
  if (!isNative || nativeReady) return;
  nativeReady = true;
  await StatusBar.setStyle({ style: Style.Dark }).catch(() => undefined);
  await StatusBar.setBackgroundColor({ color: '#060818' }).catch(() => undefined);
  CapApp.addListener('backButton', ({ canGoBack }) => {
    if (!onBack() && !canGoBack) CapApp.exitApp();
  });
  SplashScreen.hide().catch(() => undefined);
}

export function tap(style: 'light' | 'medium' = 'light') {
  if (isNative) Haptics.impact({ style: style === 'light' ? ImpactStyle.Light : ImpactStyle.Medium }).catch(() => undefined);
}
