import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import LanguageSelector from '../components/LanguageSelector';
import AudioHistory from '../components/AudioHistory';
import { synthesizeSpeech, getVoicePresets, reviewText } from '../services/api';
import './TextToVoice.css';

const PROJECT_ID=import.meta.env.VITE_PROJECT_ID;


export default function TextToVoicePage() {

  const { t }=useTranslation();
  const [language, setLanguage]=
    useState<'vi'|'en'>('vi');

  const [text, setText]=useState('');

  const textAreaRef=useRef<HTMLTextAreaElement|null>(null);

  const audioRef=useRef<HTMLAudioElement|null>(null);

  const [volume, setVolume]=useState(1);

  const [selectedSpeed, setSelectedSpeed]=
    useState(1);

  const [audioUrl, setAudioUrl]=
    useState<string|null>(null);

  const [isGenerating, setIsGenerating]=
    useState(false);

  const [error, setError]=
    useState<string|null>(null);

  const [showTextReview, setShowTextReview]=
    useState(false);

  const [isTextReviewing, setIsTextReviewing]=
    useState(false);

  const [textReviewErrors, setTextReviewErrors]=
    useState<string[]>([]);

  const [textReviewSuggestion, setTextReviewSuggestion]=
    useState('');

  const [correctedText, setCorrectedText]=
    useState('');

  const [refreshKey, setRefreshKey]=useState(0);

  const [presets, setPresets]=useState<
    Awaited<ReturnType<typeof getVoicePresets>>
  >([]);

  const [isLoadingPresets, setIsLoadingPresets]=
    useState(true);

  const [presetError, setPresetError]=
    useState<string|null>(null);

  const [selectedPreset, setSelectedPreset]=useState(
    'central_female_storytelling',
  );

  const [selectedRegion, setSelectedRegion]=
    useState('north_vietnam');

  const [selectedAudience, setSelectedAudience]=
    useState<'adult'|'child'>('adult');

  const [selectedGender, setSelectedGender]=
    useState<'male'|'female'>('female');

  const [selectedStyle, setSelectedStyle]=
    useState('storytelling');

  const [openFilter, setOpenFilter]=useState<
    'region'|'audience'|'gender'|'style'|null
  >(null);

  useEffect(() => {
    setIsLoadingPresets(true);
    setPresetError(null);

    getVoicePresets()
      .then((loadedPresets) => {
        setPresets(loadedPresets);
        setIsLoadingPresets(false);

        if (loadedPresets.length===0) {
          const message='Unable to load voice presets.';

          setPresetError(message);
          setError(message);
        }
      })
      .catch((error) => {
        console.error('Failed to load voice presets:', error);

        const message='Unable to load voice presets.';

        setPresets([]);
        setPresetError(message);
        setError(message);
        setIsLoadingPresets(false);
      });
  }, []);

  const filteredPresets=presets.filter((preset) => {
    const isChild=
      preset.character==='boy'||
      preset.character==='girl';

    const isMale=
      preset.character==='adult_male'||
      preset.character==='boy';

    const isFemale=
      preset.character==='adult_female'||
      preset.character==='girl';

    const audienceMatches=
      selectedAudience==='child'
        ? isChild
        :!isChild;

    const genderMatches=
      selectedGender==='male'
        ? isMale
        :isFemale;

    return (
      preset.region===selectedRegion&&
      audienceMatches&&
      genderMatches&&
      preset.style===selectedStyle
    );
  });

  const selectedVoicePreset=filteredPresets[0]??null;

  const hasValidPreset=selectedVoicePreset!==null;

  useEffect(() => {
    if (filteredPresets.length===0) {
      return;
    }

    const currentPresetExists=filteredPresets.some(
      (preset) => preset.id===selectedPreset,
    );

    if (!currentPresetExists) {
      setSelectedPreset(filteredPresets[0].id);
    }
  }, [
    filteredPresets,
  ]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume=volume;
    }
  }, [volume, audioUrl]);

  const handleAutoTextReview=async () => {
    if (!text.trim()) {
      setTextReviewErrors([]);
      setTextReviewSuggestion('');
      setCorrectedText('');
      setIsTextReviewing(false);
      setShowTextReview(true);
      return;
    }

    setShowTextReview(true);
    setIsTextReviewing(true);
    setTextReviewErrors([]);
    setTextReviewSuggestion('');
    setCorrectedText('');

    try {
      const response=await reviewText(text);

      setTextReviewErrors(response.errors);
      setTextReviewSuggestion(response.suggestion);
      setCorrectedText(response.correctedText);
    } catch (error) {
      console.error(
        'TEXT REVIEW ERROR:',
        error,
      );

      setTextReviewErrors([
        'Không thể kiểm tra văn bản. Vui lòng thử lại.',
      ]);
      setTextReviewSuggestion('');
      setCorrectedText('');
    } finally {
      setIsTextReviewing(false);
    }
  };
  const handleGenerate=async () => {
    if (!text.trim()||isGenerating||isLoadingPresets) {
      return;
    }

    if (presetError||presets.length===0) {
      setError(
        presetError??'Unable to load voice presets.',
      );
      return;
    }

    if (!hasValidPreset) {
      setError('Selected voice preset is unavailable.');
      return;
    }

    const selectedVoicePreset=filteredPresets[0]??null;

    if (!selectedVoicePreset) {
      setError('Selected voice preset is unavailable.');
      return;
    }

    setIsGenerating(true);
    setError(null);

    try {
      const result=await synthesizeSpeech({
        projectId: PROJECT_ID,
        text: text.trim(),
        language,

        preset: selectedVoicePreset.id,

        region: selectedVoicePreset.region as
          |'north_vietnam'
          |'central_vietnam'
          |'south_vietnam'
          |'standard_vietnamese'
          |'american_english'
          |'british_english',

        character: selectedVoicePreset.character as
          |'young_male'
          |'young_female'
          |'adult_male'
          |'adult_female'
          |'elderly_male'
          |'elderly_female'
          |'boy'
          |'girl',

        tone: selectedVoicePreset.tone as
          |'deep'
          |'neutral'
          |'high',

        emotion: selectedVoicePreset.emotion as
          |'natural'
          |'happy'
          |'sad'
          |'warm'
          |'excited'
          |'formal'
          |'angry'
          |'worried'
          |'fearful'
          |'whisper',

        style: selectedVoicePreset.style as
          |'conversation'
          |'storytelling'
          |'night_storytelling'
          |'presenter'
          |'lecture'
          |'news'
          |'podcast'
          |'advertising'
          |'cinematic',

        speed: selectedSpeed,
      });

      setAudioUrl(result.fileUrl);

      setRefreshKey((current) => current+1);

      // Refresh history after generating audio.

    } catch (err) {
      console.error(err);
      setError(t('common.error'));
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <main
      className="ttv-textarea"
    >
      <header className="ttv-header">
        <h1>{t('tts.title')}</h1>
        <p>{t('app.subtitle')}</p>
      </header>

      <section>
        <div className="ttv-input-area">

          <textarea
            ref={textAreaRef}
            className="ttv-textarea"
            value={text}
            onChange={(event) => {
              const textarea=event.currentTarget;
              const newText=textarea.value;

              setText(newText);

              requestAnimationFrame(() => {
                if (
                  document.activeElement===textarea&&
                  textarea.selectionStart===textarea.value.length
                ) {
                  textarea.scrollTop=
                    textarea.scrollHeight;
                }
              });
            }}
            placeholder={t('tts.placeholder')}
            maxLength={5000}
            rows={8}
          />

          <div className="ttv-character-count">
            {text.length} / 5000
          </div>

        </div>

        <div className="ttv-control-grid">



          <div className="ttv-filter-grid">

            {/* Vùng miền */}
            <div className="ttv-filter">
              <button
                type="button"
                className="ttv-filter-button"
                onClick={() =>
                  setOpenFilter(
                    openFilter==='region'
                      ? null
                      :'region',
                  )
                }
              >
                <span className="ttv-filter-label">
                  🌍 Vùng miền
                </span>

                <strong className="ttv-filter-value">
                  {selectedRegion==='north_vietnam'
                    ? 'Miền Bắc'
                    :selectedRegion==='central_vietnam'
                      ? 'Miền Trung'
                      :'Miền Nam'}
                </strong>
              </button>

              {openFilter==='region'&&(
                <div className="ttv-filter-menu">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRegion('north_vietnam');
                      setOpenFilter(null);
                    }}
                    className="ttv-filter-option"
                  >
                    Miền Bắc
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRegion('central_vietnam');
                      setOpenFilter(null);
                    }}
                    className="ttv-filter-option"
                  >
                    Miền Trung
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedRegion('south_vietnam');
                      setOpenFilter(null);
                    }}
                    className="ttv-filter-option"
                  >
                    Miền Nam
                  </button>
                </div>
              )}
            </div>

            {/* Đối tượng */}
            <div className="ttv-filter">
              <button
                type="button"
                onClick={() =>
                  setOpenFilter(
                    openFilter==='audience'
                      ? null
                      :'audience',
                  )
                }
                className="ttv-filter-button"
              >
                <span className="ttv-filter-label">
                  👤 Độ tuổi
                </span>

                <strong className="ttv-filter-value">
                  {selectedAudience==='child'
                    ? 'Trẻ em'
                    :'Người lớn'}
                </strong>
              </button>

              {openFilter==='audience'&&(
                <div className="ttv-filter-menu">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedAudience('child');
                      setOpenFilter(null);
                    }}
                    className="ttv-filter-option"
                  >
                    Trẻ em
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedAudience('adult');
                      setOpenFilter(null);
                    }}
                    className="ttv-filter-option"
                  >
                    Người lớn
                  </button>
                </div>
              )}
            </div>

            {/* Giới tính */}
            <div className="ttv-filter">
              <button
                type="button"
                onClick={() =>
                  setOpenFilter(
                    openFilter==='gender'
                      ? null
                      :'gender',
                  )
                }
                className="ttv-filter-button"
              >
                <span className="ttv-filter-label">
                  ⚥ Giới tính
                </span>

                <strong className="ttv-filter-value">
                  {selectedGender==='female'
                    ? 'Nữ'
                    :'Nam'}
                </strong>
              </button>

              {openFilter==='gender'&&(
                <div className="ttv-filter-menu">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedGender('female');
                      setOpenFilter(null);
                    }}
                    className="ttv-filter-option"
                  >
                    Nữ
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedGender('male');
                      setOpenFilter(null);
                    }}
                    className="ttv-filter-option"
                  >
                    Nam
                  </button>
                </div>
              )}
            </div>

            {/* Phong cách */}
            <div className="ttv-filter">
              <button
                type="button"
                onClick={() =>
                  setOpenFilter(
                    openFilter==='style'
                      ? null
                      :'style',
                  )
                }
                className="ttv-filter-button"
              >
                <span className="ttv-filter-label">
                  🎭 Phong cách
                </span>

                <strong className="ttv-filter-value">
                  {selectedStyle==='storytelling'
                    ? 'Kể chuyện'
                    :selectedStyle==='podcast'
                      ? 'Podcast'
                      :selectedStyle==='news'
                        ? 'Tin tức'
                        :selectedStyle==='lecture'
                          ? 'Giảng bài'
                          :'Điện ảnh'}
                </strong>
              </button>

              {openFilter==='style'&&(
                <div className="ttv-filter-menu">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedStyle('storytelling');
                      setOpenFilter(null);
                    }}
                    className="ttv-filter-option"
                  >
                    Kể chuyện
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedStyle('podcast');
                      setOpenFilter(null);
                    }}
                    className="ttv-filter-option"
                  >
                    Podcast
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedStyle('news');
                      setOpenFilter(null);
                    }}
                    className="ttv-filter-option"
                  >
                    Tin tức
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedStyle('lecture');
                      setOpenFilter(null);
                    }}
                    className="ttv-filter-option"
                  >
                    Giảng bài
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedStyle('cinematic');
                      setOpenFilter(null);
                    }}
                    className="ttv-filter-option"
                  >
                    Điện ảnh
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="ttv-controls">

            <div className="ttv-control">
              <div className="ttv-control-header">
                <span className="ttv-control-label">
                  🔊 Volume
                </span>

                <span className="ttv-control-value">
                  {Math.round(volume*100)}%
                </span>
              </div>

              <div className="ttv-range-row">
                <span className="ttv-range-icon">
                  🔈
                </span>

                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={volume}
                  onChange={(event) =>
                    setVolume(
                      Number(event.target.value),
                    )
                  }
                  className="ttv-range"
                  aria-label="Volume"
                />

                <span className="ttv-range-icon">
                  🔊
                </span>
              </div>
            </div>

            <div className="ttv-control">
              <div className="ttv-control-header">
                <span className="ttv-control-label">
                  ⚡ Tốc độ đọc
                </span>

                <span className="ttv-control-value">
                  {selectedSpeed.toFixed(2)}x
                </span>
              </div>

              <div className="ttv-range-row">
                <span className="ttv-range-text">
                  Chậm
                </span>

                <input
                  type="range"
                  min="0.75"
                  max="1.25"
                  step="0.05"
                  value={selectedSpeed}
                  onChange={(event) =>
                    setSelectedSpeed(
                      Number(event.target.value),
                    )
                  }
                  className="ttv-range"
                  aria-label="Tốc độ đọc"
                />

                <span className="ttv-range-text">
                  Nhanh
                </span>
              </div>
            </div>

          </div>

          <div className="ttv-bottom-grid">
            {/* Sửa câu từ */}
            <div className="ttv-bottom-card ttv-edit-card">

              <div className="ttv-bottom-card-title">
                ✍️ Sửa câu từ
              </div>

              <button
                type="button"
                className="ttv-edit-button"
                onClick={handleAutoTextReview}
              >
                🤖✨AI Tự động
              </button>

            </div>
            {/* Ngôn ngữ */}
            <div className="ttv-bottom-card ttv-language-card">

              <div className="ttv-bottom-card-title">
                🌐 Ngôn ngữ
              </div>

              <div className="ttv-bottom-language">
                <LanguageSelector
                  value={language}
                  onChange={setLanguage}
                />
              </div>

            </div>

            {/* Xử lý & Phát */}
            <div className="ttv-bottom-card ttv-play-card">

              <div className="ttv-bottom-card-title">
                Xử lý &amp; Phát
              </div>

              <button
                type="button"
                className="ttv-play-button"
                onClick={handleGenerate}
                disabled={
                  !text.trim()||
                  isGenerating||
                  isLoadingPresets||
                  !hasValidPreset
                }
                aria-label="Xử lý và phát"
              >
                <span className="ttv-play-waves">
                  <span>)))</span>
                </span>

                <span className="ttv-play-circle">
                  {isGenerating
                    ? '…'
                    :'▶'}
                </span>

                <span className="ttv-play-waves">
                  <span>(((</span>
                </span>
              </button>

            </div>
          </div>
        </div>

        {error&&(
          <p role="alert">
            {error}
          </p>
        )
        }
      </section>

      {
        audioUrl&&(
          <section className="ttv-audio-section">
            <audio
              ref={audioRef}
              className="ttv-audio"
              controls
              src={audioUrl}
            />
          </section>
        )
      }
      <AudioHistory
        projectId={PROJECT_ID}
        refreshKey={refreshKey}
      />

      {showTextReview&&(
        <div className="ttv-review-overlay">
          <div className="ttv-review-dialog">

            <div className="ttv-review-header">
              <h3>
                🤖✨ AI Tự động
              </h3>

              <button
                type="button"
                className="ttv-review-close"
                onClick={() => {
                  setShowTextReview(false);
                }}
                aria-label="Đóng"
              >
                ×
              </button>
            </div>

            {isTextReviewing? (
              <div className="ttv-review-loading">
                <div className="ttv-review-spinner">
                  ✨
                </div>

                <strong>
                  AI đang phân tích văn bản...
                </strong>

                <p>
                  Đang kiểm tra chính tả, dấu câu và cách diễn đạt.
                </p>
              </div>
            ):(
              <>
                {textReviewErrors.length===0? (
                  <div className="ttv-review-success">
                    <div className="ttv-review-success-icon">
                      ✓
                    </div>

                    <h4>
                      Văn bản đã ổn
                    </h4>

                    <p>
                      AI không phát hiện lỗi chính tả,
                      dấu câu hoặc cách diễn đạt cần chỉnh sửa.
                    </p>
                  </div>
                ):(
                  <>
                    <div className="ttv-review-summary">
                      <span>🔎</span>

                      <div>
                        <strong>
                          AI phát hiện {textReviewErrors.length} điểm
                          cần cải thiện
                        </strong>

                        <p>
                          Bạn có thể xem các đề xuất bên dưới.
                        </p>
                      </div>
                    </div>

                    <div className="ttv-review-errors">
                      {textReviewErrors.map((reviewError, index) => (
                        <div
                          key={`${index}-${reviewError}`}
                          className="ttv-review-error-item"
                        >
                          <span className="ttv-review-error-number">
                            {String(index+1).padStart(2, '0')}
                          </span>

                          <span className="ttv-review-error-text">
                            {reviewError}
                          </span>
                        </div>
                      ))}
                    </div>

                    {textReviewSuggestion&&(
                      <div className="ttv-review-suggestion">
                        <strong>
                          💡 Gợi ý của AI
                        </strong>

                        <p>
                          {textReviewSuggestion}
                        </p>
                      </div>
                    )}

                    {correctedText&&(
                      <div className="ttv-corrected-preview">
                        <strong>
                          ✨ Bản sửa đề xuất
                        </strong>

                        <div>
                          {correctedText}
                        </div>
                      </div>
                    )}
                  </>
                )}

                <div className="ttv-review-actions">
                  {textReviewErrors.length===0? (
                    <button
                      type="button"
                      className="ttv-review-confirm"
                      onClick={() => {
                        setShowTextReview(false);
                      }}
                    >
                      Đóng
                    </button>
                  ):(
                    <>
                      <button
                        type="button"
                        className="ttv-review-cancel"
                        onClick={() => {
                          setShowTextReview(false);
                        }}
                      >
                        Không, giữ nguyên
                      </button>

                      <button
                        type="button"
                        className="ttv-review-confirm"
                        onClick={() => {
                          if (correctedText) {
                            setText(correctedText);
                          }

                          setShowTextReview(false);
                        }}
                      >
                        ✓ Đồng ý sửa
                      </button>
                    </>
                  )}
                </div>
              </>
            )}

          </div>
        </div>
      )}

    </main>
  );
}
