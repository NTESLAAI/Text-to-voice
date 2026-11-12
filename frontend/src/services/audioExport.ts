import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
export async function exportAudio(url: string): Promise<void> {
  if (!url.startsWith('blob:')) throw new Error('LOCAL_AUDIO_REQUIRED');
  const blob = await (await fetch(url)).blob();
  if (blob.size > 64 * 1024 * 1024) throw new Error('AUDIO_EXPORT_LIMIT_EXCEEDED');
  const name = `audio-${crypto.randomUUID()}.wav`;
  if (!Capacitor.isNativePlatform()) {
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); return;
  }
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader(); reader.onerror = () => reject(new Error('AUDIO_EXPORT_FAILED'));
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result.split(',')[1]) : reject(new Error('AUDIO_EXPORT_FAILED'));
    reader.readAsDataURL(blob);
  });
  const path = `ttv-exports/${name}`;
  const file = await Filesystem.writeFile({ path, directory: Directory.Cache, data, recursive: true });
  try { await Share.share({ files: [file.uri] }); }
  catch { await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => undefined); throw new Error('AUDIO_EXPORT_FAILED'); }
}
