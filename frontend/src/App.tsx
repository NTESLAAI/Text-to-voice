import { useEffect, useState } from "react";

import TextToVoicePage from "./pages/TextToVoicePage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import AccountBar from "./components/AccountBar";
import { getAuthToken } from "./services/authStorage";
import AccountPage from "./pages/AccountPage";
import WebHistorySidebar from "./components/WebHistorySidebar";
import { deleteAudio } from "./services/api";
import {
  getProjectAudio,
  getProjectDialogues,
  getAudioUrl,
} from "./services/api";

function App() {
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetToken, setResetToken] = useState("");
  const [showAccount, setShowAccount] = useState(false);
  const [webView, setWebView] = useState<
    "tts" | "audio-history" | "dialogue-history"
  >("tts");

  const [projectId, setProjectId] = useState("");

  const [historyType, setHistoryType] = useState<"audio" | "dialogue" | null>(
    null,
  );

  const [historyId, setHistoryId] = useState<string | null>(null);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const handleDeleteHistory = async () => {
    if (!historyId || historyType !== "audio") {
      return;
    }

    const confirmed = window.confirm(
      "Bạn có chắc muốn xóa bản ghi âm thanh này không?",
    );

    if (!confirmed) {
      return;
    }

    try {
      await deleteAudio(historyId);
      setHistoryRefreshKey((current) => current + 1);

      setHistoryId(null);
      setHistoryType(null);
      setWebView("tts");
    } catch (error) {
      console.error("Failed to delete history audio:", error);
      window.alert("Không thể xóa bản ghi âm thanh.");
    }
  };

  const [historyAudioUrl, setHistoryAudioUrl] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token");

    if (token) {
      setResetToken(token);
    }
  }, []);
  useEffect(() => {
    async function checkAuth() {
      try {
        const token = await getAuthToken();
        setIsAuthenticated(!!token);
      } finally {
        setCheckingAuth(false);
      }
    }

    checkAuth();
  }, []);

  useEffect(() => {
    if (!projectId || !historyType || !historyId) {
      setHistoryAudioUrl(null);
      return;
    }

    let cancelled = false;

    const loadHistoryAudio = async () => {
      try {
        if (historyType === "audio") {
          const audios = await getProjectAudio(projectId);
          const audio = audios.find((item) => item.id === historyId);

          if (!cancelled) {
            setHistoryAudioUrl(audio ? getAudioUrl(audio.fileUrl) : null);
          }

          return;
        }

        const dialogues = await getProjectDialogues(projectId);
        const dialogue = dialogues.find((item) => item.id === historyId);

        if (!cancelled) {
          setHistoryAudioUrl(dialogue ? getAudioUrl(dialogue.fileUrl) : null);
        }
      } catch (error) {
        console.error("Failed to load selected history audio:", error);

        if (!cancelled) {
          setHistoryAudioUrl(null);
        }
      }
    };

    void loadHistoryAudio();

    return () => {
      cancelled = true;
    };
  }, [projectId, historyType, historyId]);

  if (checkingAuth) {
    return null;
  }

  if (!isAuthenticated) {
    if (resetToken) {
      return (
        <ResetPasswordPage
          token={resetToken}
          onResetSuccess={() => {
            setResetToken("");
          }}
        />
      );
    }
    if (showRegister) {
      return (
        <RegisterPage
          onRegisterSuccess={() => {
            setShowRegister(false);
          }}
          onSwitchToLogin={() => {
            setShowRegister(false);
          }}
        />
      );
    }

    if (showForgotPassword) {
      return (
        <ForgotPasswordPage
          onSwitchToLogin={() => {
            setShowForgotPassword(false);
          }}
        />
      );
    }

    return (
      <LoginPage
        onLoginSuccess={() => setIsAuthenticated(true)}
        onSwitchToRegister={() => setShowRegister(true)}
        onSwitchToForgotPassword={() => setShowForgotPassword(true)}
      />
    );
  }

  return (
    <div className="ttv-web-shell">
      <aside className="ttv-web-sidebar">
        <button
          type="button"
          className="ttv-web-sidebar-brand"
          onClick={() => {
            setShowAccount(false);
            setWebView("tts");
          }}
        >
          <strong>🎙️ N.TESLA.AI</strong>
          <span>Text-to-Voice</span>
        </button>

        <nav className="ttv-web-sidebar-nav" aria-label="Điều hướng">
          <div className="ttv-web-sidebar-section-title">LỊCH SỬ</div>

          <WebHistorySidebar
            projectId={projectId}
            activeType={historyType}
            activeId={historyId}
            refreshKey={historyRefreshKey}
            onSelect={(type, id) => {
              setShowAccount(false);
              setWebView(
                type === "audio" ? "audio-history" : "dialogue-history",
              );
              setHistoryType(type);
              setHistoryId(id);
            }}
          />
        </nav>

        <div className="ttv-web-sidebar-account">
          <AccountBar
            onLogout={() => setIsAuthenticated(false)}
            onAccount={() => setShowAccount(true)}
          />
        </div>
      </aside>

      <main className="ttv-web-main">
        {showAccount ? (
          <AccountPage onBack={() => setShowAccount(false)} />
        ) : webView === "tts" ? (
          <TextToVoicePage onProjectIdReady={setProjectId} />
        ) : (
          <div className="ttv-web-history-player">
            <h2>
              {historyType === "audio"
                ? "🎧 Lịch sử âm thanh"
                : "💬 Lịch sử hội thoại"}
            </h2>

            {historyAudioUrl ? (
              <div className="ttv-web-history-player-row">
                <audio controls preload="metadata" src={historyAudioUrl} />

                <button
                  type="button"
                  className="ttv-web-history-delete-button"
                  aria-label="Xóa bản ghi"
                  title="Xóa bản ghi"
                  onClick={() => {
                    void handleDeleteHistory();
                  }}
                >
                  🗑️
                </button>
              </div>
            ) : (
              <p>Đang tải âm thanh...</p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
