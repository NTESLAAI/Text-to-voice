import { useEffect, useState } from "react";

import {
  getMyProfile,
  getMySubscription,
  getMyUsage,
  type MyProfile,
  type MySubscription,
  type ProjectUsage,
} from "../services/api";

interface AccountPageProps {
  onBack: () => void;
}

function AccountPage({ onBack }: AccountPageProps) {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [subscription, setSubscription] = useState<MySubscription | null>(null);
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    async function loadProfile() {
      try {
        setError("");
        const [profileData, subscriptionData, usageData] = await Promise.all([
          getMyProfile(),
          getMySubscription(),
          getMyUsage(),
        ]);

        setProfile(profileData);
        setSubscription(subscriptionData);
        setUsage(usageData);
      } catch (err) {
        console.error("Failed to load profile:", err);
        setError("Không thể tải thông tin tài khoản.");
      } finally {
        setLoading(false);
      }
    }

    loadProfile();
  }, []);

  function formatDate(value: string) {
    return new Date(value).toLocaleDateString("vi-VN");
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        padding: "32px 24px",
        background: "#f8fafc",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          maxWidth: "760px",
          margin: "0 auto",
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{
            border: "none",
            background: "transparent",
            color: "#475569",
            fontSize: "14px",
            cursor: "pointer",
            padding: "8px 0",
            marginBottom: "16px",
          }}
        >
          ← Quay lại
        </button>

        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e7eaf0",
            borderRadius: "20px",
            padding: "32px",
            boxShadow: "0 8px 30px rgba(15, 23, 42, 0.06)",
          }}
        >
          <h1
            style={{
              margin: "0 0 8px",
              fontSize: "28px",
              color: "#0f172a",
            }}
          >
            Tài khoản của tôi
          </h1>

          <p
            style={{
              margin: "0 0 28px",
              color: "#64748b",
              fontSize: "15px",
            }}
          >
            Thông tin tài khoản của bạn
          </p>

          {loading && <p style={{ color: "#64748b" }}>Đang tải thông tin...</p>}

          {!loading && error && (
            <div
              style={{
                padding: "12px 14px",
                borderRadius: "10px",
                background: "#fee2e2",
                color: "#b91c1c",
                fontSize: "14px",
              }}
            >
              {error}
            </div>
          )}

          {!loading && !error && profile && (
            <div
              style={{
                display: "grid",
                gap: "16px",
              }}
            >
              <div>
                <div
                  style={{
                    fontSize: "13px",
                    color: "#64748b",
                    marginBottom: "6px",
                  }}
                >
                  Họ và tên
                </div>

                <div
                  style={{
                    fontSize: "16px",
                    color: "#0f172a",
                    fontWeight: 600,
                  }}
                >
                  {profile.name || "Chưa cập nhật"}
                </div>
              </div>

              <div>
                <div
                  style={{
                    fontSize: "13px",
                    color: "#64748b",
                    marginBottom: "6px",
                  }}
                >
                  Email
                </div>

                <div
                  style={{
                    fontSize: "16px",
                    color: "#0f172a",
                  }}
                >
                  {profile.email}
                </div>
              </div>

              <div>
                <div
                  style={{
                    fontSize: "13px",
                    color: "#64748b",
                    marginBottom: "6px",
                  }}
                >
                  Ngày tạo tài khoản
                </div>

                <div
                  style={{
                    fontSize: "16px",
                    color: "#0f172a",
                  }}
                >
                  {formatDate(profile.createdAt)}
                </div>
              </div>
            </div>
          )}
          {!loading && !error && profile && subscription && usage && (
            <div
              style={{
                marginTop: "32px",
                paddingTop: "28px",
                borderTop: "1px solid #e7eaf0",
              }}
            >
              <h2
                style={{
                  margin: "0 0 20px",
                  fontSize: "20px",
                  color: "#0f172a",
                }}
              >
                Gói sử dụng
              </h2>

              <div
                style={{
                  display: "grid",
                  gap: "16px",
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: "13px",
                      color: "#64748b",
                      marginBottom: "6px",
                    }}
                  >
                    Gói hiện tại
                  </div>
                  <div
                    style={{
                      fontSize: "18px",
                      color: "#0f172a",
                      fontWeight: 700,
                    }}
                  >
                    {subscription.plan.name}
                  </div>
                </div>

                <div>
                  <div
                    style={{
                      fontSize: "13px",
                      color: "#64748b",
                      marginBottom: "6px",
                    }}
                  >
                    Hạn mức
                  </div>
                  <div style={{ fontSize: "16px", color: "#0f172a" }}>
                    {usage.totalQuota.toLocaleString("vi-VN")} ký tự
                  </div>
                </div>

                <div>
                  <div
                    style={{
                      fontSize: "13px",
                      color: "#64748b",
                      marginBottom: "6px",
                    }}
                  >
                    Đã sử dụng
                  </div>
                  <div style={{ fontSize: "16px", color: "#0f172a" }}>
                    {usage.usedCharacters.toLocaleString("vi-VN")} ký tự
                  </div>
                </div>

                <div>
                  <div
                    style={{
                      fontSize: "13px",
                      color: "#64748b",
                      marginBottom: "6px",
                    }}
                  >
                    Còn lại
                  </div>
                  <div
                    style={{
                      fontSize: "18px",
                      color: "#15803d",
                      fontWeight: 700,
                    }}
                  >
                    {usage.remainingCharacters.toLocaleString("vi-VN")} ký tự
                  </div>
                </div>

                <div>
                  <div
                    style={{
                      fontSize: "13px",
                      color: "#64748b",
                      marginBottom: "6px",
                    }}
                  >
                    Ngày bắt đầu
                  </div>
                  <div style={{ fontSize: "16px", color: "#0f172a" }}>
                    {formatDate(subscription.startedAt)}
                  </div>
                </div>

                <div>
                  <div
                    style={{
                      fontSize: "13px",
                      color: "#64748b",
                      marginBottom: "6px",
                    }}
                  >
                    Ngày hết hạn
                  </div>
                  <div style={{ fontSize: "16px", color: "#0f172a" }}>
                    {formatDate(subscription.expiresAt)}
                  </div>
                </div>

                {usage.rolloverCharacters > 0 && (
                  <div>
                    <div
                      style={{
                        fontSize: "13px",
                        color: "#64748b",
                        marginBottom: "6px",
                      }}
                    >
                      Ký tự chuyển sang
                    </div>
                    <div style={{ fontSize: "16px", color: "#0f172a" }}>
                      {usage.rolloverCharacters.toLocaleString("vi-VN")} ký tự
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default AccountPage;
