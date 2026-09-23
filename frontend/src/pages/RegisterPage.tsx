import { useState } from "react";
import api, { checkEmailExists } from "../services/api";

interface RegisterPageProps {
  onRegisterSuccess: () => void;
  onSwitchToLogin: () => void;
}

function RegisterPage({
  onRegisterSuccess,
  onSwitchToLogin,
}: RegisterPageProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [emailExists, setEmailExists] = useState<boolean | null>(null);
  const [checkingEmail, setCheckingEmail] = useState(false);

  const hasMinLength = password.length >= 6;
  const hasUppercase = /[A-Z]/.test(password);
  const hasLowercase = /[a-z]/.test(password);
  const hasNumber = /\d/.test(password);

  const isPasswordValid =
    hasMinLength && hasUppercase && hasLowercase && hasNumber;

  const isPasswordMatch = password.length > 0 && password === confirmPassword;
  const isEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const canRegister =
    name.trim().length > 0 &&
    isEmailValid &&
    emailExists === false &&
    !checkingEmail &&
    isPasswordValid &&
    isPasswordMatch;

  async function handleEmailBlur() {
    const normalizedEmail = email.trim();

    if (!isEmailValid) {
      setEmailExists(null);
      return;
    }

    setCheckingEmail(true);

    try {
      const result = await checkEmailExists(normalizedEmail);
      setEmailExists(result.exists);
    } catch (error) {
      console.error("CHECK EMAIL ERROR:", error);
      setEmailExists(null);
    } finally {
      setCheckingEmail(false);
    }
  }
  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!name.trim() || !email.trim() || !password || !confirmPassword) {
      setError("Vui lòng nhập đầy đủ thông tin.");
      return;
    }

    if (!isPasswordValid) {
      setError(
        "Mật khẩu phải có ít nhất 6 ký tự, 1 chữ hoa, 1 chữ thường và 1 chữ số.",
      );
      return;
    }

    if (password !== confirmPassword) {
      setError("Mật khẩu xác nhận không khớp.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      await api.post("/auth/register", {
        name: name.trim(),
        email: email.trim(),
        password,
      });

      onRegisterSuccess();
    } catch (error: any) {
      console.error("REGISTER ERROR:", error);
      console.error("REGISTER ERROR RESPONSE:", error?.response?.data);

      setError(
        error?.response?.data?.message ||
          "Không thể đăng ký tài khoản. Vui lòng thử lại.",
      );
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
        <button
          type="button"
          onClick={onSwitchToLogin}
          disabled={loading}
          style={{
            border: "none",
            background: "transparent",
            padding: 0,
            marginBottom: "18px",
            color: "#4f46e5",
            fontSize: "14px",
            fontWeight: 600,
            cursor: loading ? "default" : "pointer",
          }}
        >
          ← Quay lại đăng nhập
        </button>
        <h1
          style={{
            margin: "0 0 10px",
            textAlign: "center",
            fontSize: "32px",
            lineHeight: 1.2,
          }}
        >
          Tạo tài khoản
        </h1>

        <p
          style={{
            margin: "0 0 30px",
            textAlign: "center",
            opacity: 0.7,
            fontSize: "15px",
          }}
        >
          Đăng ký để sử dụng Text-to-Voice
        </p>

        <form onSubmit={handleSubmit}>
          <label
            htmlFor="register-name"
            style={{
              display: "block",
              marginBottom: "9px",
              fontSize: "15px",
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
              width: "100%",
              height: "48px",
              boxSizing: "border-box",
              padding: "0 15px",
              marginBottom: "18px",
              border: "1px solid #d1d5db",
              borderRadius: "10px",
              fontSize: "16px",
              outline: "none",
            }}
          />

          <label
            htmlFor="register-email"
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
            id="register-email"
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setEmailExists(null);
            }}
            onBlur={handleEmailBlur}
            placeholder="Nhập email"
            autoComplete="email"
            disabled={loading}
            style={{
              width: "100%",
              height: "48px",
              boxSizing: "border-box",
              padding: "0 15px",
              marginBottom: "18px",
              border: "1px solid #d1d5db",
              borderRadius: "10px",
              fontSize: "16px",
              outline: "none",
            }}
          />
          {checkingEmail && (
            <div
              style={{
                marginTop: "-10px",
                marginBottom: "18px",
                fontSize: "13px",
                color: "#64748b",
              }}
            >
              Đang kiểm tra email...
            </div>
          )}

          {!checkingEmail && emailExists === true && (
            <div
              style={{
                marginTop: "-10px",
                marginBottom: "18px",
                fontSize: "13px",
                fontWeight: 600,
                color: "#dc2626",
              }}
            >
              ✕ Email này đã được đăng ký. Vui lòng nhập email khác.
            </div>
          )}

          {!checkingEmail && emailExists === false && (
            <div
              style={{
                marginTop: "-10px",
                marginBottom: "18px",
                fontSize: "13px",
                fontWeight: 600,
                color: "#16a34a",
              }}
            >
              ✓ Email có thể sử dụng.
            </div>
          )}
          <label
            htmlFor="register-password"
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
              marginBottom: "18px",
            }}
          >
            <input
              id="register-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Nhập mật khẩu"
              autoComplete="new-password"
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
                fontSize: "13px",
                fontWeight: 600,
                cursor: loading ? "default" : "pointer",
              }}
            >
              {showPassword ? "Ẩn" : "Hiện"}
            </button>
          </div>
          <div
            style={{
              marginTop: "-10px",
              marginBottom: "18px",
              fontSize: "14px",
              fontWeight: 600,
              lineHeight: 1.7,
            }}
          >
            <div style={{ color: hasMinLength ? "#16a34a" : "#64748b" }}>
              {hasMinLength ? "✓" : "○"} Ít nhất 6 ký tự
            </div>

            <div style={{ color: hasUppercase ? "#16a34a" : "#64748b" }}>
              {hasUppercase ? "✓" : "○"} Có ít nhất 1 chữ hoa
            </div>

            <div style={{ color: hasLowercase ? "#16a34a" : "#64748b" }}>
              {hasLowercase ? "✓" : "○"} Có ít nhất 1 chữ thường
            </div>

            <div style={{ color: hasNumber ? "#16a34a" : "#64748b" }}>
              {hasNumber ? "✓" : "○"} Có ít nhất 1 chữ số
            </div>
          </div>

          <label
            htmlFor="register-confirm-password"
            style={{
              display: "block",
              marginBottom: "9px",
              fontSize: "15px",
              fontWeight: 500,
            }}
          >
            Xác nhận mật khẩu
          </label>

          <div
            style={{
              position: "relative",
              marginBottom: "10px",
            }}
          >
            <input
              id="register-confirm-password"
              type={showConfirmPassword ? "text" : "password"}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Nhập lại mật khẩu"
              autoComplete="new-password"
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
              onClick={() => setShowConfirmPassword((value) => !value)}
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
                fontSize: "13px",
                fontWeight: 600,
                cursor: loading ? "default" : "pointer",
              }}
            >
              {showConfirmPassword ? "Ẩn" : "Hiện"}
            </button>
          </div>

          {confirmPassword.length > 0 && !isPasswordMatch && (
            <div
              style={{
                marginBottom: "18px",
                fontSize: "11px",
                fontWeight: 600,
                color: "#dc2626",
              }}
            >
              ✕ Mật khẩu xác nhận không giống nhau
            </div>
          )}

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
            disabled={loading || !canRegister}
            style={{
              width: "100%",
              height: "50px",
              padding: "0 16px",
              border: "none",
              borderRadius: "10px",
              fontSize: "16px",
              fontWeight: 600,
              cursor: loading || !canRegister ? "default" : "pointer",
              background: loading || !canRegister ? "#cbd5e1" : "#4f46e5",
              color: "#ffffff",
            }}
          >
            {loading ? "Đang đăng ký..." : "Đăng ký"}
          </button>
        </form>

        <div
          style={{
            marginTop: "22px",
            textAlign: "center",
            fontSize: "14px",
            color: "#64748b",
          }}
        >
          Đã có tài khoản?{" "}
          <button
            type="button"
            onClick={onSwitchToLogin}
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
            Đăng nhập
          </button>
        </div>
      </div>
    </div>
  );
}

export default RegisterPage;
