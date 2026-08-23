import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  deleteAudio,
  getAudioUrl,
  getProjectAudio,
} from '../services/api';

import type { AudioRecord } from '../services/api';

interface AudioHistoryProps {
  projectId: string;
  refreshKey?: number;
}

export default function AudioHistory({
  projectId,
  refreshKey = 0,
}: AudioHistoryProps) {
  const { t } = useTranslation();

  const [audios, setAudios] = useState<AudioRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAudios = async () => {
    try {
      setLoading(true);

      const data = await getProjectAudio(projectId);

      setAudios(data);
    } catch (error) {
      console.error('Failed to load audio history:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAudios();
  }, [projectId, refreshKey]);

  const handleDelete = async (id: string) => {
    const confirmed = window.confirm(
      t('tts.confirmDelete'),
    );

    if (!confirmed) {
      return;
    }

    try {
      await deleteAudio(id);

      setAudios((current) =>
        current.filter(
          (audio) => audio.id !== id,
        ),
      );
    } catch (error) {
      console.error('Failed to delete audio:', error);
    }
  };

  if (loading) {
    return (
      <section className="audio-history">
        <h2>{t('tts.history')}</h2>
        <p>{t('common.loading')}</p>
      </section>
    );
  }

  return (
    <section className="audio-history">
      <h2>{t('tts.history')}</h2>

      {audios.length === 0 ? (
        <p>{t('tts.empty')}</p>
      ) : (
        <div className="audio-history-list">
          {audios.map((audio) => (
            <article
              key={audio.id}
              className="audio-history-item"
            >
              <div className="audio-history-content">
                <p className="audio-history-text">
                  {audio.text}
                </p>

                <div className="audio-history-meta">
                  <span>
                    {audio.language === 'vi'
                      ? t('language.vietnamese')
                      : t('language.english')}
                  </span>

                  <span>•</span>

                  <span>
                    {t('tts.duration', {
                      duration: audio.duration.toFixed(2),
                    })}
                  </span>
                </div>

                <audio
                  controls
                  preload="none"
                  src={getAudioUrl(audio.fileUrl)}
                />
              </div>

              <button
                type="button"
                className="audio-delete-button"
                onClick={() =>
                  handleDelete(audio.id)
                }
                aria-label={t('tts.delete')}
                title={t('tts.delete')}
              >
                🗑
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}