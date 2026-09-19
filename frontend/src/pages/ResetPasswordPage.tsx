import { useState } from "react";
import { resetPassword } from "../services/api";

interface ResetPasswordPageProps {
  token: string;
  onResetSuccess: () => void;
}

function ResetPasswordPage({ token, onResetSuccess }: ResetPasswordPageProps) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!password || !confirmPassword) {
      setError("Vui lòng nhập đầy đủ thông tin.");
      return;
    }

    if (password.length < 6) {
      setError("Mật khẩu phải có ít nhất 6 ký tự.");
      return;
    }

    if (password !== confirmPassword) {
      setError("Mật khẩu xác nhận không khớp.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const result = await resetPassword(token, password);

      console.log("RESET PASSWORD RESULT:", result);

      onResetSuccess();
    } catch (error: any) {
      console.error("RESET PASSWORD ERROR:", error);
      console.error("RESET PASSWORD ERROR RESPONSE:", error?.response?.data);

      setError(
        error?.response?.data?.message ||
          "Không thể đặt lại mật khẩu. Vui lòng thử lại.",
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
        <h1
          style={{
            margin: "0 0 10px",
            textAlign: "center",
            fontSize: "32px",
            lineHeight: 1.2,
          }}
        >
          Đặt lại mật khẩu
        </h1>

        <p
          style={{
            margin: "0 0 30px",
            textAlign: "center",
            opacity: 0.7,
            fontSize: "15px",
          }}
        >
          Nhập mật khẩu mới cho tài khoản của bạn
        </p>

        <form onSubmit={handleSubmit}>
          <label
            htmlFor="reset-password"
            style={{
              display: "block",
              marginBottom: "9px",
              fontSize: "15px",
              fontWeight: 500,
            }}
          >
            Mật khẩu mới
          </label>

          <input
            id="reset-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Nhập mật khẩu mới"
            autoComplete="new-password"
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
            htmlFor="reset-confirm-password"
            style={{
              display: "block",
              marginBottom: "9px",
              fontSize: "15px",
              fontWeight: 500,
            }}
          >
            Xác nhận mật khẩu
          </label>

          <input
            id="reset-confirm-password"
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            placeholder="Nhập lại mật khẩu mới"
            autoComplete="new-password"
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
            {loading ? "Đang cập nhật..." : "Đặt lại mật khẩu"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default ResetPasswordPage;
