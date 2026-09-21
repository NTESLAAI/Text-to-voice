import { useState } from "react";
import { login } from "../services/api";
import { saveAuth } from "../services/authStorage";

interface LoginPageProps {
  onLoginSuccess: () => void;
  onSwitchToRegister: () => void;
  onSwitchToForgotPassword: () => void;
}

function LoginPage({
  onLoginSuccess,
  onSwitchToRegister,
  onSwitchToForgotPassword,
}: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const canLogin = email.trim().length > 0 && password.length > 0;
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!email.trim() || !password) {
      setError("Vui lòng nhập đầy đủ thông tin.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const result = await login(email.trim(), password);
      console.log("LOGIN RESULT:", result);

      await saveAuth(result.accessToken, result.user);
      console.log("AUTH SAVED");

      onLoginSuccess();
      console.log("LOGIN SUCCESS CALLBACK");
    } catch (error) {
      console.error("LOGIN ERROR:", error);
      setError("Email hoặc mật khẩu không đúng. Vui lòng kiểm tra lại.");
    } finally {
      setLoading(false);
    }
  }
  return (
    <div
      style={{
        minHeight: "100vh",
        width: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px 20px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: "460px",
          padding: "42px",
          borderRadius: "22px",
          boxSizing: "border-box",
          background: "var(--card-bg, #ffffff)",
          boxShadow: "0 12px 45px rgba(0, 0, 0, 0.12)",
        }}
      >
        <h1
          style={{
            margin: "0 0 10px",
            textAlign: "center",
            fontSize: "32px",
            lineHeight: 1.2,
          }}
        >
          Đăng nhập
        </h1>

        <p
          style={{
            margin: "0 0 34px",
            textAlign: "center",
            opacity: 0.7,
            fontSize: "15px",
          }}
        >
          Đăng nhập để sử dụng Text-to-Voice
        </p>

        <form onSubmit={handleSubmit}>
          <label
            htmlFor="login-email"
            style={{
              display: "block",
              marginBottom: "9px",
              fontSize: "15px",
              fontWeight: 500,
            }}
          >
            Email
          </label>

          <input
            id="login-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Nhập email"
            autoComplete="email"
            disabled={loading}
            style={{
              width: "100%",
              height: "48px",
              boxSizing: "border-box",
              padding: "0 15px",
              marginBottom: "22px",
              border: "1px solid #d1d5db",
              borderRadius: "10px",
              fontSize: "16px",
              outline: "none",
            }}
          />

          <label
            htmlFor="login-password"
            style={{
              display: "block",
              marginBottom: "9px",
              fontSize: "15px",
              fontWeight: 500,
            }}
          >
            Mật khẩu
          </label>

          <div
            style={{
              position: "relative",
              marginBottom: "22px",
            }}
          >
            <input
              id="login-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Nhập mật khẩu"
              autoComplete="current-password"
              disabled={loading}
              style={{
                width: "100%",
                height: "48px",
                boxSizing: "border-box",
                padding: "0 44px 0 15px",
                marginBottom: 0,
                border: "1px solid #d1d5db",
                borderRadius: "10px",
                fontSize: "16px",
                outline: "none",
              }}
            />

            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              disabled={loading}
              style={{
                position: "absolute",
                right: "10px",
                top: "50%",
                transform: "translateY(-50%)",
                border: "none",
                background: "transparent",
                padding: 0,
                color: "#2563eb",
                fontSize: "14px",
                fontWeight: 600,
                cursor: loading ? "default" : "pointer",
              }}
            >
              {showPassword ? "Ẩn" : "Hiện"}
            </button>
          </div>

          {error && (
            <div
              role="alert"
              style={{
                marginBottom: "18px",
                padding: "11px 13px",
                borderRadius: "9px",
                background: "#fee2e2",
                color: "#b91c1c",
                fontSize: "14px",
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !canLogin}
            style={{
              width: "100%",
              height: "50px",
              padding: "0 16px",
              border: "none",
              borderRadius: "10px",
              fontSize: "16px",
              fontWeight: 600,
              background: loading || !canLogin ? "#cbd5e1" : "#4f46e5",
              color: "#ffffff",
              cursor: loading || !canLogin ? "default" : "pointer",
            }}
          >
            {loading ? "Đang đăng nhập..." : "Đăng nhập"}
          </button>
        </form>
        <div
          style={{
            marginTop: "4px",
            textAlign: "right",
          }}
        >
          <button
            type="button"
            onClick={onSwitchToForgotPassword}
            disabled={loading}
            style={{
              border: "none",
              background: "transparent",
              padding: 0,
              color: "#4f46e5",
              fontSize: "14px",
              cursor: "pointer",
            }}
          >
            Quên mật khẩu?
          </button>
        </div>

        <div
          style={{
            marginTop: "22px",
            textAlign: "center",
            fontSize: "14px",
            color: "#64748b",
          }}
        >
          Chưa có tài khoản?{" "}
          <button
            type="button"
            onClick={onSwitchToRegister}
            disabled={loading}
            style={{
              border: "none",
              background: "transparent",
              padding: 0,
              color: "#4f46e5",
              fontSize: "14px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Đăng ký
          </button>
        </div>
      </div>
    </div>
  );
}

export default LoginPage;
