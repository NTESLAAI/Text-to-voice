import { useEffect, useState } from 'react';

import TextToVoicePage from './pages/TextToVoicePage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import AccountBar from './components/AccountBar';
import { getAuthToken } from './services/authStorage';

function App() {
  const [checkingAuth, setCheckingAuth]=useState(true);
  const [isAuthenticated, setIsAuthenticated]=useState(false);
  const [showRegister, setShowRegister]=useState(false);

  useEffect(() => {
    async function checkAuth() {
      try {
        const token=await getAuthToken();
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

    return (
      <LoginPage
        onLoginSuccess={() => setIsAuthenticated(true)}
        onSwitchToRegister={() => setShowRegister(true)}
      />
    );
  }

  return (
    <>
      <AccountBar
        onLogout={() => setIsAuthenticated(false)}
      />
      <TextToVoicePage />
    </>
  );
}

export default App;
