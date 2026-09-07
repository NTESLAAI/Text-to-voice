import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { CapacitorHttp } from '@capacitor/core';
import { useTranslation } from 'react-i18next';

import { deleteAudio, getAudioUrl, getProjectAudio } from '../services/api';

import type { AudioRecord } from '../services/api';

interface AudioHistoryProps {
  projectId: string;
  refreshKey?: number;
}

const HISTORY_PREVIEW_WORDS=12;

function getTextPreview(value: string): string {
  const text=value.trim();

  if (!text) {
    return '';
  }

  const words=text.split(/\s+/);

  if (words.length<=HISTORY_PREVIEW_WORDS) {
    return text;
  }

  return `${words
    .slice(0, HISTORY_PREVIEW_WORDS)
    .join(' ')}…`;
}

export default function AudioHistory({
  projectId,
  refreshKey=0,
}: AudioHistoryProps) {
  const { t }=useTranslation();

  const [audios, setAudios]=useState<AudioRecord[]>([]);
  const [audioUrls, setAudioUrls]=useState<Record<string, string>>({});
  const [loading, setLoading]=useState(true);
  const [expanded, setExpanded]=useState(false);

  useEffect(() => {
    let cancelled=false;
    const objectUrls: string[]=[];

    const loadAudios=async () => {
      try {
        setLoading(true);

        const data=await getProjectAudio(projectId);

        if (cancelled) {
          return;
        }

        setAudios(data);

        const urls: Record<string, string>={};

        await Promise.all(
          data.map(async (audio) => {
            try {
              const audioUrl=getAudioUrl(audio.fileUrl);

              let blob: Blob;

              if (Capacitor.isNativePlatform()) {
                const response=await CapacitorHttp.get({
                  url: audioUrl,
                  responseType: 'blob',
                });

                console.log(
                  'HISTORY AUDIO DATA SAMPLE:',
                  JSON.stringify({
                    length: typeof response.data==='string'? response.data.length:null,
                    start:
                      typeof response.data==='string'
                        ? response.data.substring(0, 100)
                        :null,
                  }),
                );

                console.log(
                  'HISTORY AUDIO NATIVE RESPONSE:',
                  JSON.stringify({
                    status: response.status,
                    dataType: typeof response.data,
                    isBlob: response.data instanceof Blob,
                    dataConstructor: response.data?.constructor?.name,
                    dataKeys:
                      response.data&&typeof response.data==='object'
                        ? Object.keys(response.data)
                        :[],
                  }),
                );

                console.log(
                  'HISTORY AUDIO NATIVE RESPONSE:',
                  JSON.stringify({
                    status: response.status,
                    dataType: typeof response.data,
                    isBlob: response.data instanceof Blob,
                    dataConstructor: response.data?.constructor?.name,
                    dataKeys:
                      response.data&&typeof response.data==='object'
                        ? Object.keys(response.data)
                        :[],
                  }),
                );

                const binaryString=atob(response.data);
                const bytes=new Uint8Array(binaryString.length);

                for (let i=0;i<binaryString.length;i++) {
                  bytes[i]=binaryString.charCodeAt(i);
                }

                blob=new Blob([bytes], {
                  type: 'audio/wav',
                });
              } else {
                const response=await fetch(audioUrl);

                if (!response.ok) {
                  throw new Error(
                    `Failed to load audio: ${response.status}`,
                  );
                }

                blob=await response.blob();
              }

              if (cancelled) {
                return;
              }

              const objectUrl=URL.createObjectURL(blob);

              objectUrls.push(objectUrl);
              urls[audio.id]=objectUrl;
            } catch (error) {
              console.error(
                'Failed to load history audio:',
                audio.id,
                error,
              );
            }
          }),
        );

        if (!cancelled) {
          setAudioUrls(urls);
        }
      } catch (error) {
        if (!cancelled) {
          console.error(
            'Failed to load audio history:',
            error,
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadAudios();

    return () => {
      cancelled=true;

      objectUrls.forEach((url) => {
        URL.revokeObjectURL(url);
      });
    };
  }, [projectId, refreshKey]);

  const handleDelete=async (id: string) => {
    const confirmed=window.confirm(
      t('tts.confirmDelete'),
    );

    if (!confirmed) {
      return;
    }

    try {
      await deleteAudio(id);

      const objectUrl=audioUrls[id];

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }

      setAudioUrls((current) => {
        const next={ ...current };
        delete next[id];
        return next;
      });

      setAudios((current) =>
        current.filter(
          (audio) => audio.id!==id,
        ),
      );
    } catch (error) {
      console.error(
        'Failed to delete audio:',
        error,
      );
    }
  };

  if (loading) {
    return (
      <section className="audio-history">
        <div className="audio-history-surface">
          <h2>{t('tts.history')}</h2>
          <p>{t('common.loading')}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="audio-history">
      <div className="audio-history-surface">
        <div className="audio-history-header">
          <h2>
            {t('tts.history')} ({audios.length})
          </h2>

          {audios.length>2&&(
            <button
              type="button"
              className="audio-history-toggle"
              onClick={() =>
                setExpanded((current) => !current)
              }
            >
              {expanded
                ? '▲ Thu gọn'
                :'▼ Xem thêm'}
            </button>
          )}
        </div>

        {audios.length===0? (
          <p>{t('tts.empty')}</p>
        ):(
          <div className="audio-history-list">
            {audios
              .slice(0, expanded? audios.length:2)
              .map((audio, index) => (
                <article
                  key={audio.id}
                  className="audio-history-item"
                >
                  <div className="audio-history-content">
                    <p className="audio-history-text">
                      {String(index+1).padStart(2, '0')}.{' '}
                      {getTextPreview(audio.text)}
                    </p>

                    <div className="audio-history-meta">
                      <span>
                        {audio.language==='vi'
                          ? t('language.vietnamese')
                          :t('language.english')}
                      </span>

                      <span>•</span>

                      <span>
                        {t('tts.duration', {
                          duration:
                            audio.duration.toFixed(2),
                        })}
                      </span>
                    </div>

                    {audioUrls[audio.id]? (
                      <audio
                        controls
                        preload="metadata"
                        src={audioUrls[audio.id]}
                      />
                    ):(
                      <audio
                        controls
                        preload="none"
                        src=""
                      />
                    )}
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
      </div>
    </section>
  );
}