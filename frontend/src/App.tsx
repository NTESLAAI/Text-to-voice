import { useEffect, useState } from "react";

import TextToVoicePage from "./pages/TextToVoicePage";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import AccountBar from "./components/AccountBar";
import { getAuthToken } from "./services/authStorage";

function App() {
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [showRegister, setShowRegister] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetToken, setResetToken] = useState("");

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
    <>
      <AccountBar onLogout={() => setIsAuthenticated(false)} />
      <TextToVoicePage />
    </>
  );
}

export default App;
