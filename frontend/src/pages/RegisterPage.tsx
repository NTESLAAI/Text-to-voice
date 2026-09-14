import { useState } from 'react';
import api from '../services/api';

interface RegisterPageProps {
  onRegisterSuccess: () => void;
  onSwitchToLogin: () => void;
}

function RegisterPage({
  onRegisterSuccess,
  onSwitchToLogin,
}: RegisterPageProps) {
  const [name, setName]=useState('');
  const [email, setEmail]=useState('');
  const [password, setPassword]=useState('');
  const [confirmPassword, setConfirmPassword]=useState('');
  const [loading, setLoading]=useState(false);
  const [error, setError]=useState('');

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!name.trim()||!email.trim()||!password||!confirmPassword) {
      setError('Vui lòng nhập đầy đủ thông tin.');
      return;
    }

    if (password.length<6) {
      setError('Mật khẩu phải có ít nhất 6 ký tự.');
      return;
    }

    if (password!==confirmPassword) {
      setError('Mật khẩu xác nhận không khớp.');
      return;
    }

    setLoading(true);
    setError('');

    try {
      await api.post('/auth/register', {
        name: name.trim(),
        email: email.trim(),
        password,
      });

      onRegisterSuccess();
    } catch (error: any) {

      console.error('REGISTER ERROR:', error);
      console.error('REGISTER ERROR RESPONSE:', error?.response?.data);

      setError(
        error?.response?.data?.message||
        'Không thể đăng ký tài khoản. Vui lòng thử lại.',
      );

    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 20px',
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '460px',
          padding: '42px',
          borderRadius: '22px',
          boxSizing: 'border-box',
          background: 'var(--card-bg, #ffffff)',
          boxShadow: '0 12px 45px rgba(0, 0, 0, 0.12)',
        }}
      >
        <h1
          style={{
            margin: '0 0 10px',
            textAlign: 'center',
            fontSize: '32px',
            lineHeight: 1.2,
          }}
        >
          Tạo tài khoản
        </h1>

        <p
          style={{
            margin: '0 0 30px',
            textAlign: 'center',
            opacity: 0.7,
            fontSize: '15px',
          }}
        >
          Đăng ký để sử dụng Text-to-Voice
        </p>

        <form onSubmit={handleSubmit}>
          <label
            htmlFor="register-name"
            style={{
              display: 'block',
              marginBottom: '9px',
              fontSize: '15px',
              fontWeight: 500,
            }}
          >
            Họ và tên
          </label>

          <input
            id="register-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Nhập họ và tên"
            autoComplete="name"
            disabled={loading}
            style={{
              width: '100%',
              height: '48px',
              boxSizing: 'border-box',
              padding: '0 15px',
              marginBottom: '18px',
              border: '1px solid #d1d5db',
              borderRadius: '10px',
              fontSize: '16px',
              outline: 'none',
            }}
          />

          <label
            htmlFor="register-email"
            style={{
              display: 'block',
              marginBottom: '9px',
              fontSize: '15px',
              fontWeight: 500,
            }}
          >
            Email
          </label>

          <input
            id="register-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Nhập email"
            autoComplete="email"
            disabled={loading}
            style={{
              width: '100%',
              height: '48px',
              boxSizing: 'border-box',
              padding: '0 15px',
              marginBottom: '18px',
              border: '1px solid #d1d5db',
              borderRadius: '10px',
              fontSize: '16px',
              outline: 'none',
            }}
          />

          <label
            htmlFor="register-password"
            style={{
              display: 'block',
              marginBottom: '9px',
              fontSize: '15px',
              fontWeight: 500,
            }}
          >
            Mật khẩu
          </label>

          <input
            id="register-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Nhập mật khẩu"
            autoComplete="new-password"
            disabled={loading}
            style={{
              width: '100%',
              height: '48px',
              boxSizing: 'border-box',
              padding: '0 15px',
              marginBottom: '18px',
              border: '1px solid #d1d5db',
              borderRadius: '10px',
              fontSize: '16px',
              outline: 'none',
            }}
          />

          <label
            htmlFor="register-confirm-password"
            style={{
              display: 'block',
              marginBottom: '9px',
              fontSize: '15px',
              fontWeight: 500,
            }}
          >
            Xác nhận mật khẩu
          </label>

          <input
            id="register-confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            placeholder="Nhập lại mật khẩu"
            autoComplete="new-password"
            disabled={loading}
            style={{
              width: '100%',
              height: '48px',
              boxSizing: 'border-box',
              padding: '0 15px',
              marginBottom: '20px',
              border: '1px solid #d1d5db',
              borderRadius: '10px',
              fontSize: '16px',
              outline: 'none',
            }}
          />

          {error&&(
            <div
              role="alert"
              style={{
                marginBottom: '18px',
                padding: '11px 13px',
                borderRadius: '9px',
                background: '#fee2e2',
                color: '#b91c1c',
                fontSize: '14px',
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              height: '50px',
              padding: '0 16px',
              border: 'none',
              borderRadius: '10px',
              fontSize: '16px',
              fontWeight: 600,
              cursor: loading? 'default':'pointer',
            }}
          >
            {loading? 'Đang đăng ký...':'Đăng ký'}
          </button>
        </form>

        <div
          style={{
            marginTop: '22px',
            textAlign: 'center',
            fontSize: '14px',
            color: '#64748b',
          }}
        >
          Đã có tài khoản?{' '}
          <button
            type="button"
            onClick={onSwitchToLogin}
            disabled={loading}
            style={{
              border: 'none',
              background: 'transparent',
              padding: 0,
              color: '#4f46e5',
              fontSize: '14px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Đăng nhập
          </button>
        </div>
      </div>
    </div>
  );
}

export default RegisterPage;
