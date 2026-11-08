/** Qué modelos de visión opcionales puede usar el procesamiento ahora mismo: los instalados que además permite el perfil del dispositivo. */
import { currentProfile } from '@starblitz/shared';
import type { DeviceCaps, Settings } from '@starblitz/shared';
import type { VisionModelManager } from '../models/vision';
import type { VisionFlags } from './visionProtocol';

export interface FlagInputs {
  models: Pick<VisionModelManager, 'isInstalled'>;
  settings: Settings;
  caps: DeviceCaps;
  mobile: boolean;
}

/**
 * Misma regla que el motor del PC (`Processor._inpaint_mode` y la elección de OCR): con el perfil «automático» decide la
 * potencia del dispositivo; si la persona fija un modo en Ajustes, manda ese. Manga OCR (≈460 MB en memoria) y LaMa
 * (≈208 MB) solo se usan si están instalados y el perfil los permite.
 */
export async function computeVisionFlags(i: FlagInputs): Promise<VisionFlags> {
  const profile = currentProfile(i.caps, i.settings.processing.profile, i.mobile);
  const chosen = i.settings.processing.inpaint;
  const inpaintMode = chosen === 'auto' ? profile.inpaint : chosen;
  const [detector, mangaInstalled, lamaInstalled] = await Promise.all([
    i.models.isInstalled('text-detector'), i.models.isInstalled('manga-ocr'), i.models.isInstalled('lama'),
  ]);
  return {
    detector,
    manga: profile.ocr_japanese === 'manga-ocr' && mangaInstalled,
    lama: inpaintMode !== 'fast' && lamaInstalled,
    inpaintMode,
  };
}
