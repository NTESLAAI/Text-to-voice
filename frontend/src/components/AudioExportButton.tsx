import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { exportAudio } from '../services/audioExport';
export default function AudioExportButton({ url }: { url: string }) {
  const { t } = useTranslation(); const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  async function save() { setBusy(true); setFailed(false); try { await exportAudio(url); } catch { setFailed(true); } finally { setBusy(false); } }
  return <><button type="button" disabled={busy} onClick={() => void save()}>{t('mobile.exportAudio')}</button>{failed && <p role="alert">{t('mobile.failed')}</p>}</>;
}
