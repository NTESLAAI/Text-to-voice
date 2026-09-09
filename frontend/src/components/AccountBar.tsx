import { useEffect, useState } from 'react';
import { clearAuth, getAuthUser, type StoredUser } from '../services/authStorage';

interface AccountBarProps {
  onLogout: () => void;
}

function AccountBar({ onLogout }: AccountBarProps) {
  const [user, setUser] = useState<StoredUser | null>(null);

  useEffect(() => {
    getAuthUser().then(setUser);
  }, []);

  async function handleLogout() {
    await clearAuth();
    onLogout();
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: '16px',
        right: '20px',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        padding: '8px 10px 8px 14px',
        borderRadius: '999px',
        background: 'rgba(255, 255, 255, 0.95)',
        border: '1px solid #e7eaf0',
        boxShadow: '0 4px 16px rgba(15, 23, 42, 0.08)',
      }}
    >
      <span
        style={{
          maxWidth: '220px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontSize: '14px',
          color: '#475569',
        }}
      >
        {user?.name || user?.email || 'Tài khoản'}
      </span>

      <button
        type="button"
        onClick={handleLogout}
        style={{
          border: 'none',
          borderRadius: '999px',
          padding: '8px 14px',
          background: '#f1f5f9',
          color: '#334155',
          fontSize: '13px',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Đăng xuất
      </button>
    </div>
  );
}

export default AccountBar;
