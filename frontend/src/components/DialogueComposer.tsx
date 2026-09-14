import { useEffect, useRef, useState } from 'react';

import { getProjectUsage, synthesizeDialogue } from '../services/api';
import { countBillableCharacters } from '../utils/characterCount';

type Gender='male'|'female';
type Character=
  |'young_male'
  |'young_female'
  |'adult_male'
  |'adult_female'
  |'elderly_male'
  |'elderly_female'
  |'boy'
  |'girl';
type Region=
  |'north_vietnam'
  |'central_vietnam'
  |'south_vietnam';
type Style=
  |'conversation'
  |'storytelling'
  |'night_storytelling'
  |'poetry'
  |'podcast'
  |'news'
  |'lecture'
  |'cinematic';

interface DialogueSpeaker {
  gender: Gender;
  character: Character;
  region: Region;
}

interface DialogueTurn {
  id: number;
  speaker: 'A'|'B';
  text: string;
  style: Style;
}

const CHARACTER_OPTIONS: Record<Gender, Array<{
  value: Character;
  label: string;
}>>={
  male: [
    { value: 'boy', label: 'Trẻ em' },
    { value: 'young_male', label: 'Người trẻ' },
    { value: 'adult_male', label: 'Người lớn' },
    { value: 'elderly_male', label: 'Cao tuổi' },
  ],
  female: [
    { value: 'girl', label: 'Trẻ em' },
    { value: 'young_female', label: 'Người trẻ' },
    { value: 'adult_female', label: 'Người lớn' },
    { value: 'elderly_female', label: 'Cao tuổi' },
  ],
};

const REGION_OPTIONS: Array<{
  value: Region;
  label: string;
}>=[
    { value: 'north_vietnam', label: 'Miền Bắc' },
    { value: 'central_vietnam', label: 'Miền Trung' },
    { value: 'south_vietnam', label: 'Miền Nam' },
  ];

const STYLE_OPTIONS: Array<{
  value: Style;
  label: string;
}>=[
    { value: 'conversation', label: 'Tự nhiên' },
    { value: 'storytelling', label: 'Kể chuyện' },
    { value: 'night_storytelling', label: 'Chuyện đêm' },
    { value: 'poetry', label: 'Đọc thơ' },
    { value: 'podcast', label: 'Podcast' },
    { value: 'news', label: 'Tin tức' },
    { value: 'lecture', label: 'Giảng bài' },
    { value: 'cinematic', label: 'Điện ảnh' },
  ];

function SpeakerConfig({
  label,
  speaker,
  onChange,
}: {
  label: 'A'|'B';
  speaker: DialogueSpeaker;
  onChange: (speaker: DialogueSpeaker) => void;
}) {
  return (
    <fieldset className="dialogue-speaker-card">
      <legend>Nhân vật {label}</legend>

      <label className="dialogue-field">
        <span>Giới tính</span>
        <select
          value={speaker.gender}
          onChange={(event) => {
            const gender=event.target.value as Gender;
            const character=
              gender==='male'
                ? 'adult_male'
                :'adult_female';

            onChange({
              ...speaker,
              gender,
              character,
            });
          }}
        >
          <option value="male">Nam</option>
          <option value="female">Nữ</option>
        </select>
      </label>

      <label className="dialogue-field">
        <span>Độ tuổi</span>
        <select
          value={speaker.character}
          onChange={(event) => onChange({
            ...speaker,
            character: event.target.value as Character,
          })}
        >
          {CHARACTER_OPTIONS[speaker.gender].map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="dialogue-field">
        <span>Vùng miền</span>
        <select
          value={speaker.region}
          onChange={(event) => onChange({
            ...speaker,
            region: event.target.value as Region,
          })}
        >
          {REGION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

export default function DialogueComposer({
  projectId,
  language,
  speed,
  usage,
  onUsageUpdated,
}: {
  projectId: string;
  language: 'vi'|'en';
  speed: number;
  usage: {
    plan: string;
    characterLimit: number;
    usedCharacters: number;
    remainingCharacters: number;
  }|null;
  onUsageUpdated: (usage: {
    plan: string;
    characterLimit: number;
    usedCharacters: number;
    remainingCharacters: number;
  }) => void;
}) {
  const [isOpen, setIsOpen]=useState(false);
  const [speakerA, setSpeakerA]=useState<DialogueSpeaker>({
    gender: 'female',
    character: 'adult_female',
    region: 'north_vietnam',
  });
  const [speakerB, setSpeakerB]=useState<DialogueSpeaker>({
    gender: 'male',
    character: 'adult_male',
    region: 'south_vietnam',
  });
  const [turns, setTurns]=useState<DialogueTurn[]>([
    {
      id: 1,
      speaker: 'A',
      text: '',
      style: 'conversation',
    },
  ]);
  const [isGenerating, setIsGenerating]=useState(false);
  const [error, setError]=useState<string|null>(null);
  const [audioUrl, setAudioUrl]=useState<string|null>(null);
  const [lastGeneratedCharacterCount, setLastGeneratedCharacterCount]=useState(0);
  const [lastGeneratedFingerprint, setLastGeneratedFingerprint]=
    useState<string|null>(null);

  const [showRegenerateConfirm, setShowRegenerateConfirm]=
    useState(false);
  const audioRef=useRef<HTMLAudioElement|null>(null);

  const dialogueCharacterCount=turns.reduce(
    (total, turn) => total+countBillableCharacters(turn.text, language),
    0,
  );
  const getDialogueGenerationFingerprint=() => {
    return JSON.stringify({
      language,
      speed,
      speakerA,
      speakerB,
      turns: turns.map((turn) => ({
        speaker: turn.speaker,
        text: turn.text.trim(),
        style: turn.style,
      })),
    });
  };

  useEffect(() => {
    if (!audioUrl) {
      return;
    }

    const audio=audioRef.current;

    if (audio) {
      void audio.play().catch(() => undefined);
    }

    return () => {
      URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const updateTurn=(
    id: number,
    update: Partial<Omit<DialogueTurn, 'id'>>,
  ) => {
    if (typeof update.text==='string'&&usage) {
      const newTurns=turns.map((turn) => (
        turn.id===id
          ? { ...turn, ...update }
          :turn
      ));

      const newCharacterCount=newTurns.reduce(
        (total, turn) =>
          total+countBillableCharacters(turn.text, language),
        0,
      );

      if (
        newCharacterCount>
        usage.remainingCharacters+lastGeneratedCharacterCount
      ) {
        setError(
          `Bạn đã sử dụng hết hạn mức còn lại (${Math.max(
            0,
            usage.remainingCharacters,
          ).toLocaleString('vi-VN')} ký tự).`,
        );
        return;
      }

      setError(null);
    }

    setTurns((current) => current.map((turn) => (
      turn.id===id
        ? { ...turn, ...update }
        :turn
    )));
  };

  const addTurn=() => {
    setTurns((current) => [
      ...current,
      {
        id: Date.now(),
        speaker: current.at(-1)?.speaker==='A'? 'B':'A',
        text: '',
        style: 'conversation',
      },
    ]);
  };

  const removeTurn=(id: number) => {
    setTurns((current) => (
      current.length===1
        ? current
        :current.filter((turn) => turn.id!==id)
    ));
  };

  const resizeTurnTextarea=(textarea: HTMLTextAreaElement) => {
    textarea.style.height='auto';
    textarea.style.height=`${textarea.scrollHeight}px`;
  };

  const handleGenerate=async () => {
    const cleanedTurns=turns.map((turn) => ({
      speaker: turn.speaker,
      text: turn.text.trim(),
      style: turn.style,
    }));

    const hasEmptyTurn=cleanedTurns.some((turn) => !turn.text);

    const characterCount=cleanedTurns.reduce(
      (total, turn) => total+countBillableCharacters(turn.text, language),
      0,
    );

    if (!projectId) {
      setError('Không tìm thấy dự án để tạo hội thoại.');
      return;
    }

    if (hasEmptyTurn) {
      setError('Vui lòng nhập nội dung cho tất cả lượt thoại.');
      return;
    }

    if (characterCount>10000) {
      setError('Hội thoại không được vượt quá 10.000 ký tự.');
      return;
    }

    if (
      usage&&
      characterCount>usage.remainingCharacters
    ) {
      setError(
        `Bạn đã sử dụng hết hạn mức còn lại (${Math.max(
          0,
          usage.remainingCharacters,
        ).toLocaleString('vi-VN')} ký tự).`,
      );
      return;
    }

    setIsGenerating(true);
    setError(null);

    try {
      const result=await synthesizeDialogue({
        projectId,
        language,
        speakerA,
        speakerB,
        turns: cleanedTurns,
        speed,
      });

      setAudioUrl(result.fileUrl);
      const updatedUsage=await getProjectUsage(projectId);
      onUsageUpdated(updatedUsage);
      setLastGeneratedCharacterCount(characterCount);
      setLastGeneratedFingerprint(getDialogueGenerationFingerprint());

      if (usage) {
        onUsageUpdated({
          ...usage,
          usedCharacters: usage.usedCharacters+characterCount,
          remainingCharacters: Math.max(
            0,
            usage.remainingCharacters-characterCount,
          ),
        });
      }
    } catch (error) {
      console.error('DIALOGUE TTS ERROR:', error);
      setError('Không thể tạo hội thoại. Vui lòng thử lại.');
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <section className="dialogue-composer" aria-label="Tạo hội thoại">
      <button
        type="button"
        className="dialogue-composer-toggle"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={isOpen}
      >
        <span>💬 Tạo hội thoại</span>

        <span aria-hidden="true">{isOpen? '−':'+'}</span>
      </button>

      {isOpen&&(
        <div className="dialogue-composer-content">
          <p className="dialogue-composer-description">
            Thiết lập hai nhân vật cố định, rồi nhập từng lượt thoại theo thứ tự.
          </p>

          <div className="dialogue-speakers">
            <SpeakerConfig
              label="A"
              speaker={speakerA}
              onChange={setSpeakerA}
            />
            <SpeakerConfig
              label="B"
              speaker={speakerB}
              onChange={setSpeakerB}
            />
          </div>

          <div className="dialogue-turns-header">
            <h2>Lượt thoại</h2>
            <button
              type="button"
              className="dialogue-add-turn"
              onClick={addTurn}
            >
              + Thêm lượt
            </button>
          </div>

          <div className="dialogue-turns">
            <div className="dialogue-turn-columns" aria-hidden="true">
              <span />
              <span>Nhân vật</span>
              <span>Nội dung</span>
              <span>Phong cách</span>
              <span />
            </div>

            {turns.map((turn, index) => (
              <article className="dialogue-turn" key={turn.id}>
                <span className="dialogue-turn-number">
                  {index+1}
                </span>

                <label className="dialogue-field">
                  <select
                    value={turn.speaker}
                    aria-label={`Nhân vật lượt thoại ${index+1}`}
                    onChange={(event) => updateTurn(turn.id, {
                      speaker: event.target.value as 'A'|'B',
                    })}
                  >
                    <option value="A">A</option>
                    <option value="B">B</option>
                  </select>
                </label>

                <label className="dialogue-field dialogue-turn-text">
                  <textarea
                    rows={1}
                    value={turn.text}
                    aria-label={`Nội dung lượt thoại ${index+1}`}
                    onChange={(event) => updateTurn(turn.id, {
                      text: event.target.value,
                    })}
                    onInput={(event) => {
                      resizeTurnTextarea(event.currentTarget);
                    }}
                    placeholder="Nhập câu thoại..."
                    maxLength={1000}
                  />
                </label>

                <label className="dialogue-field">
                  <select
                    value={turn.style}
                    aria-label={`Phong cách lượt thoại ${index+1}`}
                    onChange={(event) => updateTurn(turn.id, {
                      style: event.target.value as Style,
                    })}
                  >
                    {STYLE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  className="dialogue-remove-turn"
                  onClick={() => removeTurn(turn.id)}
                  disabled={turns.length===1}
                  aria-label={`Xóa lượt thoại ${index+1}`}
                >
                  ×
                </button>
              </article>
            ))}
          </div>

          <button
            type="button"
            className="dialogue-generate-button"
            onClick={() => {
              const fingerprint=getDialogueGenerationFingerprint();

              if (
                lastGeneratedFingerprint&&
                fingerprint===lastGeneratedFingerprint
              ) {
                setShowRegenerateConfirm(true);
                return;
              }

              void handleGenerate();
            }}
            disabled={isGenerating}
          >
            {isGenerating? (
              'Đang tạo hội thoại…'
            ):(
              <>
                <span>🎙️ Tạo hội thoại</span>
                {usage&&(
                  <span className="dialogue-generate-usage">
                    Gói {usage.plan} · Còn{' '}
                    {Math.max(
                      0,
                      usage.remainingCharacters+
                      lastGeneratedCharacterCount-
                      dialogueCharacterCount,
                    ).toLocaleString('vi-VN')} ký tự
                  </span>
                )}
              </>
            )}
          </button>

          {error&&(
            <p className="dialogue-error" role="alert">
              {error}
            </p>
          )}

          {audioUrl&&(
            <div className="dialogue-audio-result">
              <audio ref={audioRef} controls src={audioUrl} />
            </div>
          )}

          {showRegenerateConfirm&&(
            <div className="ttv-confirm-overlay">
              <div className="ttv-confirm-dialog">
                <div className="ttv-confirm-title">
                  ⚠️ Tạo lại hội thoại?
                </div>

                <div className="ttv-confirm-message">
                  Đoạn hội thoại không thay đổi. Bạn có muốn tiếp tục tạo
                  hội thoại không?
                  <br />
                  Việc tạo lại sẽ sử dụng hạn mức ký tự.
                </div>

                <div className="ttv-confirm-actions">
                  <button
                    type="button"
                    className="ttv-confirm-cancel"
                    onClick={() => setShowRegenerateConfirm(false)}
                  >
                    Hủy
                  </button>

                  <button
                    type="button"
                    className="ttv-confirm-ok"
                    onClick={() => {
                      setShowRegenerateConfirm(false);
                      void handleGenerate();
                    }}
                  >
                    Tiếp tục tạo
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
