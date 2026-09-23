import { useEffect, useState } from "react";

import { getProjectAudio, getProjectDialogues } from "../services/api";

import type { AudioRecord, DialogueRecord } from "../services/api";

interface WebHistorySidebarProps {
  projectId: string;
  activeType: "audio" | "dialogue" | null;
  activeId: string | null;
  refreshKey?: number;
  onSelect: (type: "audio" | "dialogue", id: string) => void;
}

const HISTORY_PREVIEW_WORDS = 10;

function getTextPreview(value: string): string {
  const text = value.trim();

  if (!text) {
    return "Không có nội dung";
  }

  const words = text.split(/\s+/);

  if (words.length <= HISTORY_PREVIEW_WORDS) {
    return text;
  }

  return `${words.slice(0, HISTORY_PREVIEW_WORDS).join(" ")}…`;
}

function getDialoguePreview(dialogue: DialogueRecord): string {
  const text = dialogue.turns
    .sort((a, b) => a.order - b.order)
    .map((turn) => turn.text.trim())
    .filter(Boolean)
    .join(" ");

  return getTextPreview(text);
}

export default function WebHistorySidebar({
  projectId,
  activeType,
  activeId,
  refreshKey = 0,
  onSelect,
}: WebHistorySidebarProps) {
  const [audios, setAudios] = useState<AudioRecord[]>([]);
  const [dialogues, setDialogues] = useState<DialogueRecord[]>([]);
  const [audioOpen, setAudioOpen] = useState(false);
  const [dialogueOpen, setDialogueOpen] = useState(false);

  useEffect(() => {
    if (!projectId) {
      return;
    }

    let cancelled = false;

    const loadHistory = async () => {
      try {
        const [audioData, dialogueData] = await Promise.all([
          getProjectAudio(projectId),
          getProjectDialogues(projectId),
        ]);

        if (cancelled) {
          return;
        }

        setAudios(audioData);
        setDialogues(dialogueData);
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to load web history:", error);
        }
      }
    };

    void loadHistory();

    return () => {
      cancelled = true;
    };
  }, [projectId, refreshKey]);

  return (
    <div className="ttv-web-sidebar-history">
      <button
        type="button"
        className="ttv-web-sidebar-nav-item"
        onClick={() => setAudioOpen((current) => !current)}
        aria-expanded={audioOpen}
      >
        <span>🎧</span>
        <span className="ttv-web-sidebar-nav-label">
          Lịch sử âm thanh ({audios.length})
        </span>
        <span className="ttv-web-sidebar-nav-arrow">
          {audioOpen ? "⌃" : "⌄"}
        </span>
      </button>

      {audioOpen && (
        <div className="ttv-web-sidebar-history-list">
          {audios.length === 0 ? (
            <div className="ttv-web-sidebar-history-empty">
              Chưa có lịch sử âm thanh
            </div>
          ) : (
            audios.map((audio, index) => (
              <button
                key={audio.id}
                type="button"
                className={`ttv-web-sidebar-history-item ${
                  activeType === "audio" && activeId === audio.id
                    ? "active"
                    : ""
                }`}
                onClick={() => onSelect("audio", audio.id)}
                title={audio.text}
              >
                {index + 1}. {getTextPreview(audio.text)}
              </button>
            ))
          )}
        </div>
      )}

      <button
        type="button"
        className="ttv-web-sidebar-nav-item"
        onClick={() => setDialogueOpen((current) => !current)}
        aria-expanded={dialogueOpen}
      >
        <span>💬</span>
        <span className="ttv-web-sidebar-nav-label">
          Lịch sử hội thoại ({dialogues.length})
        </span>
        <span className="ttv-web-sidebar-nav-arrow">
          {dialogueOpen ? "⌃" : "⌄"}
        </span>
      </button>

      {dialogueOpen && (
        <div className="ttv-web-sidebar-history-list">
          {dialogues.length === 0 ? (
            <div className="ttv-web-sidebar-history-empty">
              Chưa có lịch sử hội thoại
            </div>
          ) : (
            dialogues.map((dialogue, index) => (
              <button
                key={dialogue.id}
                type="button"
                className={`ttv-web-sidebar-history-item ${
                  activeType === "dialogue" && activeId === dialogue.id
                    ? "active"
                    : ""
                }`}
                onClick={() => onSelect("dialogue", dialogue.id)}
                title={getDialoguePreview(dialogue)}
              >
                {index + 1}. {getDialoguePreview(dialogue)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
