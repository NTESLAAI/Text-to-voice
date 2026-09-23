import { useState } from "react";
import { forgotPassword } from "../services/api";

interface ForgotPasswordPageProps {
  onSwitchToLogin: () => void;
}

function ForgotPasswordPage({ onSwitchToLogin }: ForgotPasswordPageProps) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!email.trim()) {
      setError("Vui lòng nhập email.");
      return;
    }

    setLoading(true);
    setError("");
    setMessage("");

    try {
      const result = await forgotPassword(email.trim());

      setMessage(
        "Nếu email tồn tại trong hệ thống, yêu cầu đặt lại mật khẩu đã được tạo.",
      );

      console.log("FORGOT PASSWORD RESULT:", result);
    } catch (error) {
      console.error("FORGOT PASSWORD ERROR:", error);
      setError("Không thể gửi yêu cầu. Vui lòng thử lại.");
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
          style={{
            border: "none",
            background: "transparent",
            padding: 0,
            marginBottom: "18px",
            color: "#4f46e5",
            fontSize: "14px",
            fontWeight: 600,
            cursor: "pointer",
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
          Quên mật khẩu
        </h1>

        <p
          style={{
            margin: "0 0 30px",
            textAlign: "center",
            opacity: 0.7,
            fontSize: "15px",
          }}
        >
          Nhập email để yêu cầu đặt lại mật khẩu
        </p>

        <form onSubmit={handleSubmit}>
          <label
            htmlFor="forgot-password-email"
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
            id="forgot-password-email"
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
              marginBottom: "20px",
              border: "1px solid #d1d5db",
              borderRadius: "10px",
              fontSize: "16px",
              outline: "none",
            }}
          />

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

          {message && (
            <div
              role="status"
              style={{
                marginBottom: "18px",
                padding: "11px 13px",
                borderRadius: "9px",
                background: "#dcfce7",
                color: "#166534",
                fontSize: "14px",
              }}
            >
              {message}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%",
              height: "50px",
              padding: "0 16px",
              border: "none",
              borderRadius: "10px",
              fontSize: "16px",
              fontWeight: 600,
              cursor: loading ? "default" : "pointer",
            }}
          >
            {loading ? "Đang gửi..." : "Gửi yêu cầu"}
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
          Nhớ mật khẩu?{" "}
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

export default ForgotPasswordPage;
