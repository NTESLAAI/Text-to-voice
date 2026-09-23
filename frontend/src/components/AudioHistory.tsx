import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { CapacitorHttp } from "@capacitor/core";
import { useTranslation } from "react-i18next";

import {
  deleteAudio,
  deleteDialogue,
  getAudioUrl,
  getProjectAudio,
  getProjectDialogues,
} from "../services/api";

import type { AudioRecord, DialogueRecord } from "../services/api";

interface AudioHistoryProps {
  projectId: string;
  refreshKey?: number;
}

const HISTORY_PREVIEW_WORDS = 12;

function getTextPreview(value: string): string {
  const text = value.trim();

  if (!text) {
    return "";
  }

  const words = text.split(/\s+/);

  if (words.length <= HISTORY_PREVIEW_WORDS) {
    return text;
  }

  return `${words.slice(0, HISTORY_PREVIEW_WORDS).join(" ")}…`;
}

export default function AudioHistory({
  projectId,
  refreshKey = 0,
}: AudioHistoryProps) {
  const { t } = useTranslation();

  const [audios, setAudios] = useState<AudioRecord[]>([]);
  const [dialogueUrls, setDialogueUrls] = useState<Record<string, string>>({});
  const [dialogues, setDialogues] = useState<DialogueRecord[]>([]);
  const [audioUrls, setAudioUrls] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<"audio" | "dialogue">("audio");

  useEffect(() => {
    let cancelled = false;
    const objectUrls: string[] = [];

    const loadAudios = async () => {
      try {
        setLoading(true);

        const data = await getProjectAudio(projectId);
        const dialogueData = await getProjectDialogues(projectId);

        if (cancelled) {
          return;
        }

        setAudios(data);
        setDialogues(dialogueData);

        const urls: Record<string, string> = {};

        await Promise.all(
          data.map(async (audio) => {
            try {
              const audioUrl = getAudioUrl(audio.fileUrl);

              let blob: Blob;

              if (Capacitor.isNativePlatform()) {
                const response = await CapacitorHttp.get({
                  url: audioUrl,
                  responseType: "blob",
                });

                console.log(
                  "HISTORY AUDIO DATA SAMPLE:",
                  JSON.stringify({
                    length:
                      typeof response.data === "string"
                        ? response.data.length
                        : null,
                    start:
                      typeof response.data === "string"
                        ? response.data.substring(0, 100)
                        : null,
                  }),
                );

                console.log(
                  "HISTORY AUDIO NATIVE RESPONSE:",
                  JSON.stringify({
                    status: response.status,
                    dataType: typeof response.data,
                    isBlob: response.data instanceof Blob,
                    dataConstructor: response.data?.constructor?.name,
                    dataKeys:
                      response.data && typeof response.data === "object"
                        ? Object.keys(response.data)
                        : [],
                  }),
                );

                console.log(
                  "HISTORY AUDIO NATIVE RESPONSE:",
                  JSON.stringify({
                    status: response.status,
                    dataType: typeof response.data,
                    isBlob: response.data instanceof Blob,
                    dataConstructor: response.data?.constructor?.name,
                    dataKeys:
                      response.data && typeof response.data === "object"
                        ? Object.keys(response.data)
                        : [],
                  }),
                );

                const binaryString = atob(response.data);
                const bytes = new Uint8Array(binaryString.length);

                for (let i = 0; i < binaryString.length; i++) {
                  bytes[i] = binaryString.charCodeAt(i);
                }

                blob = new Blob([bytes], {
                  type: "audio/wav",
                });
              } else {
                const response = await fetch(audioUrl);

                if (!response.ok) {
                  throw new Error(`Failed to load audio: ${response.status}`);
                }

                blob = await response.blob();
              }

              if (cancelled) {
                return;
              }

              const objectUrl = URL.createObjectURL(blob);

              objectUrls.push(objectUrl);
              urls[audio.id] = objectUrl;
            } catch (error) {
              console.error("Failed to load history audio:", audio.id, error);
            }
          }),
        );

        if (!cancelled) {
          setAudioUrls(urls);

          const dialogueUrlsMap: Record<string, string> = {};

          await Promise.all(
            dialogueData.map(async (dialogue) => {
              try {
                const dialogueUrl = getAudioUrl(dialogue.fileUrl);

                let blob: Blob;

                if (Capacitor.isNativePlatform()) {
                  const response = await CapacitorHttp.get({
                    url: dialogueUrl,
                    responseType: "blob",
                  });

                  const binaryString = atob(response.data);
                  const bytes = new Uint8Array(binaryString.length);

                  for (let i = 0; i < binaryString.length; i++) {
                    bytes[i] = binaryString.charCodeAt(i);
                  }

                  blob = new Blob([bytes], {
                    type: "audio/wav",
                  });
                } else {
                  const response = await fetch(dialogueUrl);

                  if (!response.ok) {
                    throw new Error(
                      `Failed to load dialogue audio: ${response.status}`,
                    );
                  }

                  blob = await response.blob();
                }

                if (cancelled) {
                  return;
                }

                const objectUrl = URL.createObjectURL(blob);

                objectUrls.push(objectUrl);
                dialogueUrlsMap[dialogue.id] = objectUrl;
              } catch (error) {
                console.error(
                  "Failed to load dialogue history audio:",
                  dialogue.id,
                  error,
                );
              }
            }),
          );

          setDialogueUrls(dialogueUrlsMap);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to load audio history:", error);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadAudios();

    return () => {
      cancelled = true;

      objectUrls.forEach((url) => {
        URL.revokeObjectURL(url);
      });
    };
  }, [projectId, refreshKey]);

  const handleDelete = async (id: string, type: "audio" | "dialogue") => {
    const confirmed = window.confirm(t("tts.confirmDelete"));

    if (!confirmed) {
      return;
    }

    try {
      if (type === "audio") {
        await deleteAudio(id);

        const objectUrl = audioUrls[id];

        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }

        setAudioUrls((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });

        setAudios((current) => current.filter((audio) => audio.id !== id));

        return;
      }

      await deleteDialogue(id);

      const objectUrl = dialogueUrls[id];

      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }

      setDialogueUrls((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });

      setDialogues((current) =>
        current.filter((dialogue) => dialogue.id !== id),
      );
    } catch (error) {
      console.error(
        type === "audio"
          ? "Failed to delete audio:"
          : "Failed to delete dialogue:",
        error,
      );
    }
  };

  if (loading) {
    return (
      <section className="audio-history">
        <div className="audio-history-surface">
          <h2>{t("tts.history")}</h2>
          <p>{t("common.loading")}</p>
        </div>
      </section>
    );
  }

  return (
    <section className="audio-history">
      <div className="audio-history-surface">
        <div className="audio-history-header">
          <div className="audio-history-tabs">
            <button
              type="button"
              className={activeTab === "audio" ? "active" : ""}
              onClick={() => {
                setActiveTab("audio");
                setExpanded(false);
              }}
            >
              🎙️ Lịch sử âm thanh ({audios.length})
            </button>

            <button
              type="button"
              className={activeTab === "dialogue" ? "active" : ""}
              onClick={() => {
                setActiveTab("dialogue");
                setExpanded(false);
              }}
            >
              💬 Lịch sử hội thoại ({dialogues.length})
            </button>
          </div>

          {((activeTab === "audio" && audios.length > 2) ||
            (activeTab === "dialogue" && dialogues.length > 2)) && (
            <button
              type="button"
              className="audio-history-toggle"
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? "▲" : "▼"}
            </button>
          )}
        </div>

        {activeTab === "audio" ? (
          audios.length === 0 ? (
            <p>{t("tts.empty")}</p>
          ) : (
            <div className="audio-history-list">
              {audios
                .slice(0, expanded ? audios.length : 2)
                .map((audio, index) => (
                  <article key={audio.id} className="audio-history-item">
                    <div className="audio-history-content">
                      <p className="audio-history-text">
                        {String(index + 1).padStart(2, "0")}.{" "}
                        {getTextPreview(audio.text)}
                      </p>

                      <div className="audio-history-meta">
                        <span>
                          {audio.language === "vi"
                            ? t("language.vietnamese")
                            : t("language.english")}
                        </span>

                        <span>•</span>

                        <span>
                          {t("tts.duration", {
                            duration: audio.duration.toFixed(2),
                          })}
                        </span>
                      </div>

                      {audioUrls[audio.id] ? (
                        <audio
                          controls
                          preload="metadata"
                          src={audioUrls[audio.id]}
                        />
                      ) : (
                        <audio controls preload="none" src="" />
                      )}
                    </div>

                    <button
                      type="button"
                      className="audio-delete-button"
                      onClick={() => handleDelete(audio.id, "audio")}
                      aria-label={t("tts.delete")}
                      title={t("tts.delete")}
                    >
                      🗑
                    </button>
                  </article>
                ))}
            </div>
          )
        ) : dialogues.length === 0 ? (
          <p>{t("tts.empty")}</p>
        ) : (
          <div className="audio-history-list">
            {dialogues
              .slice(0, expanded ? dialogues.length : 2)
              .map((dialogue, index) => (
                <article key={dialogue.id} className="audio-history-item">
                  <div className="audio-history-content">
                    <p className="audio-history-text">
                      {String(index + 1).padStart(2, "0")}.{" "}
                      {getTextPreview(
                        dialogue.turns
                          .slice()
                          .sort((a, b) => a.order - b.order)
                          .map((turn) => turn.text)
                          .join(" "),
                      )}
                    </p>

                    <div className="audio-history-meta">
                      <span>Hội thoại</span>

                      <span>•</span>

                      <span>
                        {t("tts.duration", {
                          duration: dialogue.duration.toFixed(2),
                        })}
                      </span>
                    </div>

                    {dialogueUrls[dialogue.id] ? (
                      <audio
                        controls
                        preload="metadata"
                        src={dialogueUrls[dialogue.id]}
                      />
                    ) : (
                      <audio controls preload="none" src="" />
                    )}
                  </div>

                  <button
                    type="button"
                    className="audio-delete-button"
                    onClick={() => handleDelete(dialogue.id, "dialogue")}
                    aria-label={t("tts.delete")}
                    title="Xóa hội thoại"
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
