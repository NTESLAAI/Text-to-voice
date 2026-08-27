import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import AudioHistory from '../components/AudioHistory';
import { synthesizeSpeech, getVoicePresets, reviewText } from '../services/api';
import './TextToVoice.css';
import iconNam from '../assets/Icon Nam.png';
import iconNu from '../assets/Icon Nu.png';
import flagVi from '../assets/Flag-Vi.png';
import flagEn from '../assets/Flag-En.png';
import ageIcon from '../assets/Age.png';
import earthIcon from '../assets/Earth.png';
import styleIcon from '../assets/Style.png';
import logo from '../assets/Logo.png';

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

  const [lastGeneratedFingerprint, setLastGeneratedFingerprint]=
    useState<string|null>(null);

  const [showRegenerateConfirm, setShowRegenerateConfirm]=
    useState(false);

  const [openFilter, setOpenFilter]=useState<
    'region'|'audience'|'gender'|'style'|null
  >(null);

  useEffect(() => {
    setIsLoadingPresets(true);

    getVoicePresets()
      .then((loadedPresets) => {
        setPresets(loadedPresets);
        setIsLoadingPresets(false);

        if (loadedPresets.length===0) {
          const message='Unable to load voice presets.';

          setError(message);
        }
      })
      .catch((error) => {
        console.error('Failed to load voice presets:', error);

        const message='Unable to load voice presets.';

        setPresets([]);
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

  const getGenerationFingerprint=() => {
    return JSON.stringify({
      text: text.trim(),
      language,
      region: selectedRegion,
      audience: selectedAudience,
      gender: selectedGender,
      style: selectedStyle,
      speed: selectedSpeed,
    });
  };

  const handleGenerate=async () => {
    if (!text.trim()||isGenerating||isLoadingPresets) {
      return;
    }

    setIsGenerating(true);
    setError(null);

    try {
      // Không gửi preset ở đây.
      // TTS phải sử dụng trực tiếp các lựa chọn hiện tại của người dùng.

      // Nếu có preset phù hợp thì dùng preset.
      // Nếu không có, tự tạo cấu hình từ các lựa chọn hiện tại.
      const fallbackCharacter=
        selectedAudience==='child'
          ? selectedGender==='male'
            ? 'boy'
            :'girl'
          :selectedGender==='male'
            ? 'adult_male'
            :'adult_female';

      const styleSettings={
        storytelling: {
          tone: 'neutral',
          emotion: 'warm',
        },
        podcast: {
          tone: 'neutral',
          emotion: 'warm',
        },
        news: {
          tone: 'neutral',
          emotion: 'formal',
        },
        lecture: {
          tone: 'neutral',
          emotion: 'natural',
        },
        cinematic: {
          tone: 'deep',
          emotion: 'warm',
        },
      } as const;

      const fallbackStyleSettings=
        styleSettings[
        selectedStyle as keyof typeof styleSettings
        ]??styleSettings.storytelling;

      const result=await synthesizeSpeech({
        projectId: PROJECT_ID,
        text: text.trim(),
        language,

        region: selectedRegion as
          |'north_vietnam'
          |'central_vietnam'
          |'south_vietnam'
          |'standard_vietnamese'
          |'american_english'
          |'british_english',

        character: fallbackCharacter as
          |'young_male'
          |'young_female'
          |'adult_male'
          |'adult_female'
          |'elderly_male'
          |'elderly_female'
          |'boy'
          |'girl',

        tone: fallbackStyleSettings.tone as
          |'deep'
          |'neutral'
          |'high',

        emotion: fallbackStyleSettings.emotion as
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

        style: selectedStyle as
          |'conversation'
          |'storytelling'
          |'night_storytelling'
          |'presenter'
          |'lecture'
          |'news'
          |'podcast'
          |'advertising'
          |'cinematic',

        speed:
          selectedSpeed,
      });

      setAudioUrl(result.fileUrl);
      setLastGeneratedFingerprint(
        getGenerationFingerprint(),
      );
      setRefreshKey((current) => current+1);
    } catch (err) {
      console.error(err);
      setError(t('common.error'));
    } finally {
      setIsGenerating(false);
    }
  };

  const handleGenerateClick=() => {
    const fingerprint=getGenerationFingerprint();

    if (
      lastGeneratedFingerprint&&
      fingerprint===lastGeneratedFingerprint
    ) {
      setShowRegenerateConfirm(true);
      return;
    }

    void handleGenerate();
  };

  return (
    <main
      className="ttv-page"
    >
      <header className="ttv-header">
        <div className="ttv-header-brand">
          <img
            src={logo}
            alt="Logo"
            className="ttv-header-logo"
          />

          <div className="ttv-header-text">
            <h1>{t('tts.title')}</h1>
            <p>{t('app.subtitle')}</p>
          </div>
        </div>
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
                  <span className="ttv-label-icon ttv-earth-icon">
                    <img
                      src={earthIcon}
                      alt=""
                      aria-hidden="true"
                    />
                  </span>
                  Vùng miền
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
                  <span className="ttv-label-icon ttv-age-icon">
                    <img
                      src={ageIcon}
                      alt=""
                      aria-hidden="true"
                    />
                  </span>
                  Độ tuổi
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
            <div className="ttv-filter ttv-gender-filter">
              <span className="ttv-filter-label">
                Giới tính
              </span>

              <div className="ttv-gender-icons">

                {/* NAM */}
                <button
                  type="button"
                  className={`ttv-gender-button ttv-gender-male ${selectedGender==='male'? 'active':''
                    }`}
                  onClick={() => setSelectedGender('male')}
                  aria-label="Chọn Nam"
                  aria-pressed={selectedGender==='male'}
                >
                  <img
                    src={iconNam}
                    alt="Nam"
                    className="ttv-gender-image"
                  />
                </button>

                {/* NỮ */}
                <button
                  type="button"
                  className={`ttv-gender-button ttv-gender-female ${selectedGender==='female'? 'active':''
                    }`}
                  onClick={() => setSelectedGender('female')}
                  aria-label="Chọn Nữ"
                  aria-pressed={selectedGender==='female'}
                >
                  <img
                    src={iconNu}
                    alt="Nữ"
                    className="ttv-gender-image"
                  />
                </button>

              </div>
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
                  <span className="ttv-label-icon ttv-style-icon">
                    <img
                      src={styleIcon}
                      alt=""
                      aria-hidden="true"
                    />
                  </span>
                  Phong cách
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
                  <span className="ttv-label-icon">⚡</span>
                  Tốc độ đọc
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
                <span className="ttv-label-icon">✍️</span>
                Sửa câu từ
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

              <div className="ttv-language-selector">

                <button
                  type="button"
                  className={`ttv-language-option ${language==='vi'? 'active':''
                    }`}
                  onClick={() => setLanguage('vi')}
                  aria-label="Chọn Tiếng Việt"
                  aria-pressed={language==='vi'}
                >
                  <span className="ttv-language-flag">
                    <img src={flagVi} alt="Tiếng Việt" />
                  </span>

                  <span className="ttv-language-name">
                    Tiếng Việt
                  </span>
                </button>

                <button
                  type="button"
                  className={`ttv-language-option ${language==='en'? 'active':''
                    }`}
                  onClick={() => setLanguage('en')}
                  aria-label="Chọn Tiếng Anh"
                  aria-pressed={language==='en'}
                >
                  <span className="ttv-language-flag">
                    <img src={flagEn} alt="Tiếng Anh" />
                  </span>

                  <span className="ttv-language-name">
                    English
                  </span>
                </button>

              </div>

            </div>

            {/* 🎙️Tạo giọng đọc */}
            <div className="ttv-bottom-card ttv-play-card">

              <div className="ttv-bottom-card-title">
                <span className="ttv-label-icon">🎙️</span>
                Tạo giọng đọc
              </div>

              <button
                type="button"
                className="ttv-play-button"
                onClick={handleGenerateClick}
                disabled={
                  !text.trim()||
                  isGenerating||
                  isLoadingPresets
                }
                aria-label="Tạo giọng đọc"
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
      {showRegenerateConfirm&&(
        <div className="ttv-confirm-overlay">
          <div className="ttv-confirm-dialog">

            <div className="ttv-confirm-header">
              <h3>
                ⚠️ Tạo lại giọng đọc?
              </h3>

              <button
                type="button"
                className="ttv-confirm-close"
                onClick={() => {
                  setShowRegenerateConfirm(false);
                }}
                aria-label="Đóng"
              >
                ×
              </button>
            </div>

            <div className="ttv-confirm-content">
              <p>
                Bạn vừa tạo đoạn âm thanh này với cùng
                nội dung và cùng cấu hình giọng đọc.
              </p>

              <p>
                Tạo lại sẽ gọi AI và có thể sử dụng thêm
                hạn mức.
              </p>
            </div>

            <div className="ttv-confirm-actions">
              <button
                type="button"
                className="ttv-confirm-cancel"
                onClick={() => {
                  setShowRegenerateConfirm(false);
                }}
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
                Tạo lại
              </button>
            </div>

          </div>
        </div>
      )}
    </main>
  );
}
