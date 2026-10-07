import { useEffect, useState } from "react";

import {
  changePassword,
  createPayment,
  getMyProfile,
  getMySubscription,
  getMyUsage,
  type CreatePaymentResult,
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
  const [payment, setPayment] = useState<CreatePaymentResult | null>(null);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [paymentError, setPaymentError] = useState("");
  const isBusinessPlan = subscription?.plan === "BUSINESS";
  const [selectedUpgradePlan, setSelectedUpgradePlan] = useState<string | null>(
    null,
  );
  const [selectedUpgradeOption, setSelectedUpgradeOption] = useState<
    "TRANSFER_QUOTA" | "CONVERT_TO_CREDIT" | null
  >(null);
  const [showPaymentThankYou, setShowPaymentThankYou] = useState(false);
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);
  const hasMinLength = newPassword.length >= 6;
  const hasUppercase = /[A-Z]/.test(newPassword);
  const hasNumber = /\d/.test(newPassword);
  const hasLowercase = /[a-z]/.test(newPassword);

  const isNewPasswordValid =
    hasMinLength && hasUppercase && hasLowercase && hasNumber;

  const isSamePassword =
    currentPassword.length > 0 &&
    newPassword.length > 0 &&
    currentPassword === newPassword;

  const canChangePassword =
    currentPassword.length > 0 &&
    isNewPasswordValid &&
    !isSamePassword &&
    newPassword === confirmPassword;

  useEffect(() => {
    async function loadProfile() {
      try {
        setError("");

        const [profileData, subscriptionData] = await Promise.all([
          getMyProfile(),
          getMySubscription(),
        ]);

        setProfile(profileData);
        setSubscription(subscriptionData);

        // Trong cửa sổ gia hạn 24 giờ, tài khoản không được sử dụng
        // TTS/Dialogue nên getMyUsage() có thể không có dữ liệu.
        if (subscriptionData.renewalAvailable) {
          setUsage(null);
        } else {
          const usageData = await getMyUsage();
          setUsage(usageData);
        }
      } catch (err) {
        console.error("Failed to load profile:", err);
        setError("Không thể tải thông tin tài khoản.");
      } finally {
        setLoading(false);
      }
    }

    loadProfile();
  }, []);

  async function handleChangePassword() {
    setPasswordMessage("");
    setPasswordError("");

    if (!currentPassword || !newPassword || !confirmPassword) {
      setPasswordError("Vui lòng nhập đầy đủ thông tin.");
      return;
    }

    if (!isNewPasswordValid) {
      setPasswordError(
        "Mật khẩu phải có ít nhất 6 ký tự, 1 chữ hoa, 1 chữ thường và 1 chữ số.",
      );
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError("Mật khẩu mới và xác nhận mật khẩu không giống nhau.");
      return;
    }

    try {
      setChangingPassword(true);

      const result = await changePassword(currentPassword, newPassword);

      setPasswordMessage(result.message);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (err: any) {
      console.error("Change password failed:", err);
      console.error("Change password error response:", err?.response);
      console.error("Change password error data:", err?.response?.data);
      console.error("Change password error message:", err?.message);

      const message = err?.response?.data?.message || "Không thể đổi mật khẩu.";

      setPasswordError(Array.isArray(message) ? message.join(", ") : message);
    } finally {
      setChangingPassword(false);
    }
  }
  function handleCreatePayment(planCode: string) {
    setPaymentError("");
    setPayment(null);
    setSelectedUpgradePlan(planCode);
    setSelectedUpgradeOption(null);
    setShowPaymentThankYou(false);
  }

  async function handleConfirmPayment() {
    if (!selectedUpgradePlan) return;

    // Paid → Paid: bắt buộc chọn một trong hai phương án Upgrade.
    if (
      !subscription?.renewalAvailable &&
      subscription?.plan !== "FREE" &&
      !selectedUpgradeOption
    ) {
      return;
    }

    setPaymentError("");
    setPayment(null);

    try {
      setPaymentLoading(true);

      const result = await createPayment(
        selectedUpgradePlan,
        subscription?.renewalAvailable || subscription?.plan === "FREE"
          ? undefined
          : (selectedUpgradeOption ?? undefined),
      );

      setPayment(result);
      setShowPaymentThankYou(true);
    } catch (err: any) {
      console.error("Create payment failed:", err);

      const message =
        err?.response?.data?.message || "Không thể tạo yêu cầu thanh toán.";

      setPaymentError(Array.isArray(message) ? message.join(", ") : message);
    } finally {
      setPaymentLoading(false);
    }
  }

  function formatDate(value: string) {
    return new Date(value).toLocaleDateString("vi-VN");
  }

  const planCatalog: Record<string, { name: string; price: number }> = {
    BASIC: { name: "Basic", price: 129000 },
    PRO: { name: "Pro", price: 299000 },
    BUSINESS: { name: "Business", price: 799000 },
  };

  const selectedPlanInfo = selectedUpgradePlan
    ? planCatalog[selectedUpgradePlan]
    : null;

  const isRenewalFlow = Boolean(subscription?.renewalAvailable);
  const isFreePurchaseFlow = subscription?.plan === "FREE";
  const isUpgradeFlow =
    !isRenewalFlow && !isFreePurchaseFlow && Boolean(selectedUpgradePlan);

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

              {profile.email && (
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
              )}

              {profile.phone && (
                <div>
                  <div
                    style={{
                      fontSize: "13px",
                      color: "#64748b",
                      marginBottom: "6px",
                    }}
                  >
                    Số điện thoại
                  </div>

                  <div
                    style={{
                      fontSize: "16px",
                      color: "#0f172a",
                    }}
                  >
                    {profile.phone}
                  </div>
                </div>
              )}

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
          {!loading &&
            !error &&
            profile &&
            subscription &&
            (subscription.renewalAvailable || usage) && (
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
                {subscription.renewalAvailable && (
                  <div
                    style={{
                      marginBottom: "20px",
                      padding: "16px",
                      border: "1px solid #f59e0b",
                      borderRadius: "12px",
                      background: "#fffbeb",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "16px",
                        fontWeight: 700,
                        color: "#92400e",
                        marginBottom: "8px",
                      }}
                    >
                      Đang trong thời gian gia hạn
                    </div>

                    <div
                      style={{
                        fontSize: "14px",
                        color: "#78350f",
                        lineHeight: 1.5,
                      }}
                    >
                      Gói {subscription.planName} đã hết hạn. Bạn còn thời gian
                      gia hạn 24 giờ để tiếp tục sử dụng dịch vụ.
                    </div>

                    <div
                      style={{
                        marginTop: "8px",
                        fontSize: "14px",
                        color: "#78350f",
                      }}
                    >
                      Có thể gia hạn đến:{" "}
                      <strong>
                        {subscription.renewalExpiresAt
                          ? formatDate(subscription.renewalExpiresAt)
                          : ""}
                      </strong>
                    </div>
                  </div>
                )}
                {!subscription.renewalAvailable && usage && (
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
                        {subscription.planName}
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
                        {usage.remainingCharacters.toLocaleString("vi-VN")} ký
                        tự
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
                          {usage.rolloverCharacters.toLocaleString("vi-VN")} ký
                          tự
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          <div
            style={{
              marginTop: "32px",
              paddingTop: "28px",
              borderTop: "1px solid #e7eaf0",
            }}
          >
            <h2
              style={{
                margin: 0,
                fontSize: "22px",
                fontWeight: 700,
                color: "#111827",
              }}
            >
              {isBusinessPlan
                ? "🏆 Đẳng cấp VIP"
                : subscription?.renewalAvailable
                  ? "Gia hạn gói"
                  : "Nâng cấp gói"}
            </h2>

            <p
              style={{
                margin: "8px 0 0",
                color: "#6b7280",
                fontSize: "14px",
              }}
            >
              {isBusinessPlan
                ? "Bạn đang sở hữu gói cao nhất của N.TESLA.AI."
                : subscription?.renewalAvailable
                  ? "Chọn một gói trả phí để tiếp tục sử dụng dịch vụ."
                  : "Chọn gói cao hơn để tăng hạn mức sử dụng."}
            </p>
            {isBusinessPlan && (
              <div
                style={{
                  marginTop: "24px",
                  padding: "28px 24px",
                  borderRadius: "16px",
                  border: "1px solid #f3d36b",
                  background:
                    "linear-gradient(135deg, #fffdf5 0%, #fff8dc 50%, #fffdf5 100%)",
                  textAlign: "center",
                  boxShadow: "0 6px 20px rgba(180, 140, 40, 0.08)",
                }}
              >
                <div
                  style={{
                    fontSize: "36px",
                    marginBottom: "10px",
                  }}
                >
                  🏆
                </div>

                <div
                  style={{
                    fontSize: "24px",
                    fontWeight: 800,
                    color: "#a16207",
                    letterSpacing: "1px",
                  }}
                >
                  ĐẲNG CẤP VIP
                </div>

                <div
                  style={{
                    marginTop: "8px",
                    fontSize: "18px",
                    fontWeight: 700,
                    color: "#713f12",
                  }}
                >
                  BUSINESS
                </div>

                <div
                  style={{
                    marginTop: "6px",
                    fontSize: "14px",
                    color: "#854d0e",
                  }}
                >
                  Gói cao nhất của N.TESLA.AI
                </div>

                <div
                  style={{
                    marginTop: "18px",
                    fontSize: "16px",
                    fontWeight: 600,
                    color: "#713f12",
                  }}
                >
                  ✨ Bạn đã đạt cấp độ cao nhất!
                </div>

                <div
                  style={{
                    marginTop: "6px",
                    fontSize: "14px",
                    color: "#92400e",
                  }}
                >
                  Hãy tận hưởng toàn bộ đặc quyền của gói Business.
                </div>
              </div>
            )}
            {!isBusinessPlan && (
              <>
                {!selectedUpgradePlan && (
                  <div
                    style={{
                      display: "grid",
                      gap: "12px",
                    }}
                  >
                    {[
                      { code: "BASIC", name: "Basic", price: 129000 },
                      { code: "PRO", name: "Pro", price: 299000 },
                      { code: "BUSINESS", name: "Business", price: 799000 },
                    ]
                      .filter((plan) => {
                        if (subscription?.renewalAvailable) {
                          return true;
                        }

                        const currentPrices: Record<string, number> = {
                          FREE: 0,
                          BASIC: 129000,
                          PRO: 299000,
                          BUSINESS: 799000,
                        };

                        return (
                          plan.price >
                          (subscription
                            ? (currentPrices[subscription.plan] ?? 0)
                            : 0)
                        );
                      })
                      .map((plan) => (
                        <div
                          key={plan.code}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: "16px",
                            padding: "16px",
                            border: "1px solid #e2e8f0",
                            borderRadius: "12px",
                            background: "#f8fafc",
                          }}
                        >
                          <div>
                            <div
                              style={{
                                fontSize: "16px",
                                fontWeight: 700,
                                color: "#0f172a",
                              }}
                            >
                              {plan.name}
                            </div>

                            <div
                              style={{
                                marginTop: "4px",
                                fontSize: "14px",
                                color: "#64748b",
                              }}
                            >
                              {plan.price.toLocaleString("vi-VN")} VND / 30 ngày
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={() => handleCreatePayment(plan.code)}
                            disabled={paymentLoading}
                            style={{
                              border: "none",
                              borderRadius: "9px",
                              padding: "10px 16px",
                              background: paymentLoading
                                ? "#94a3b8"
                                : "#2563eb",
                              color: "#ffffff",
                              fontSize: "14px",
                              fontWeight: 600,
                              cursor: paymentLoading
                                ? "not-allowed"
                                : "pointer",
                            }}
                          >
                            {paymentLoading
                              ? "Đang xử lý..."
                              : subscription?.renewalAvailable
                                ? plan.code === subscription.plan
                                  ? "Gia hạn"
                                  : "Chọn gói"
                                : "Nâng cấp"}
                          </button>
                        </div>
                      ))}
                  </div>
                )}

                {selectedUpgradePlan && selectedPlanInfo && !payment && (
                  <div
                    style={{
                      marginTop: "20px",
                      padding: "20px",
                      border: "1px solid #bfdbfe",
                      borderRadius: "14px",
                      background: "#eff6ff",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "18px",
                        fontWeight: 700,
                        color: "#0f172a",
                        marginBottom: "16px",
                      }}
                    >
                      Yêu cầu thanh toán
                    </div>

                    <div style={{ marginBottom: "10px" }}>
                      Gói mới: <strong>{selectedPlanInfo.name}</strong>
                    </div>

                    <div style={{ marginBottom: "10px" }}>
                      Số tiền cần thanh toán:{" "}
                      <strong>
                        {selectedPlanInfo.price.toLocaleString("vi-VN")} VND
                      </strong>
                    </div>

                    <div style={{ marginBottom: "14px" }}>
                      Trạng thái: <strong>PENDING</strong>
                    </div>

                    {isUpgradeFlow && (
                      <div
                        style={{
                          marginBottom: "14px",
                          padding: "14px",
                          borderTop: "1px solid #bfdbfe",
                          borderBottom: "1px solid #bfdbfe",
                        }}
                      >
                        <div
                          style={{
                            fontSize: "14px",
                            fontWeight: 700,
                            color: "#0f172a",
                            marginBottom: "10px",
                          }}
                        >
                          Chọn phương án nâng cấp
                        </div>

                        <label
                          style={{
                            display: "block",
                            padding: "12px",
                            marginBottom: "10px",
                            border: "1px solid #dbeafe",
                            borderRadius: "10px",
                            background:
                              selectedUpgradeOption === "TRANSFER_QUOTA"
                                ? "#dbeafe"
                                : "#ffffff",
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="radio"
                            name="upgradeOption"
                            value="TRANSFER_QUOTA"
                            checked={selectedUpgradeOption === "TRANSFER_QUOTA"}
                            onChange={() =>
                              setSelectedUpgradeOption("TRANSFER_QUOTA")
                            }
                            style={{ marginRight: "8px" }}
                          />
                          <strong>Chuyển toàn bộ quota còn lại</strong>

                          <div
                            style={{
                              marginTop: "6px",
                              marginLeft: "24px",
                              fontSize: "13px",
                              color: "#64748b",
                              lineHeight: 1.5,
                            }}
                          >
                            Toàn bộ quota còn lại của gói hiện tại sẽ được
                            chuyển sang gói mới. Không giảm giá gói mới.
                          </div>
                        </label>

                        <label
                          style={{
                            display: "block",
                            padding: "12px",
                            border: "1px solid #dbeafe",
                            borderRadius: "10px",
                            background:
                              selectedUpgradeOption === "CONVERT_TO_CREDIT"
                                ? "#dbeafe"
                                : "#ffffff",
                            cursor: "pointer",
                          }}
                        >
                          <input
                            type="radio"
                            name="upgradeOption"
                            value="CONVERT_TO_CREDIT"
                            checked={
                              selectedUpgradeOption === "CONVERT_TO_CREDIT"
                            }
                            onChange={() =>
                              setSelectedUpgradeOption("CONVERT_TO_CREDIT")
                            }
                            style={{ marginRight: "8px" }}
                          />
                          <strong>Quy đổi quota thành tiền</strong>

                          <div
                            style={{
                              marginTop: "6px",
                              marginLeft: "24px",
                              fontSize: "13px",
                              color: "#64748b",
                              lineHeight: 1.5,
                            }}
                          >
                            Quota còn lại sẽ được quy đổi thành tiền và trừ vào
                            giá gói mới. Quota cũ sẽ không được chuyển sang.
                          </div>
                        </label>
                      </div>
                    )}

                    <div
                      style={{
                        marginBottom: "16px",
                        paddingTop: "14px",
                        borderTop: "1px solid #bfdbfe",
                      }}
                    >
                      <div style={{ marginBottom: "8px" }}>
                        Ngân hàng: <strong>MBBank</strong>
                      </div>
                      <div style={{ marginBottom: "8px" }}>
                        Số tài khoản: <strong>256668689</strong>
                      </div>
                      <div>
                        Chủ tài khoản:{" "}
                        <strong>
                          CONG TY CO PHAN TRI TUE NHAN TAO N.TESLA.AI
                        </strong>
                      </div>
                    </div>

                    <div
                      style={{
                        display: "flex",
                        justifyContent: "flex-end",
                        gap: "10px",
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedUpgradePlan(null);
                          setSelectedUpgradeOption(null);
                          setShowPaymentThankYou(false);
                          setPayment(null);
                          setPaymentError("");
                        }}
                        style={{
                          border: "1px solid #cbd5e1",
                          borderRadius: "9px",
                          padding: "10px 18px",
                          background: "#ffffff",
                          color: "#475569",
                          fontSize: "14px",
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        Hủy
                      </button>

                      <button
                        type="button"
                        disabled={
                          paymentLoading ||
                          (isUpgradeFlow && !selectedUpgradeOption)
                        }
                        onClick={handleConfirmPayment}
                        style={{
                          border: "none",
                          borderRadius: "9px",
                          padding: "10px 18px",
                          background:
                            paymentLoading ||
                            (isUpgradeFlow && !selectedUpgradeOption)
                              ? "#94a3b8"
                              : "#2563eb",
                          color: "#ffffff",
                          fontSize: "14px",
                          fontWeight: 600,
                          cursor:
                            paymentLoading ||
                            (isUpgradeFlow && !selectedUpgradeOption)
                              ? "not-allowed"
                              : "pointer",
                        }}
                      >
                        {paymentLoading ? "Đang xử lý..." : "Xác nhận"}
                      </button>
                    </div>
                  </div>
                )}

                {paymentError && (
                  <div
                    style={{
                      marginTop: "16px",
                      padding: "10px 12px",
                      borderRadius: "8px",
                      background: "#fee2e2",
                      color: "#b91c1c",
                      fontSize: "14px",
                    }}
                  >
                    {paymentError}
                  </div>
                )}

                {payment && showPaymentThankYou && (
                  <div
                    style={{
                      marginTop: "16px",
                      padding: "20px",
                      borderRadius: "12px",
                      border: "1px solid #bbf7d0",
                      background: "#f0fdf4",
                      color: "#166534",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "17px",
                        fontWeight: 700,
                        marginBottom: "12px",
                      }}
                    >
                      Cảm ơn bạn đã tin tưởng và sử dụng N.TESLA.AI!
                    </div>

                    <div
                      style={{
                        fontSize: "14px",
                        lineHeight: 1.6,
                        marginBottom: "8px",
                      }}
                    >
                      Yêu cầu{" "}
                      {payment.paymentType === "RENEWAL"
                        ? "gia hạn"
                        : "nâng cấp"}{" "}
                      gói <strong>{payment.planName}</strong> của bạn đã được
                      ghi nhận.
                    </div>

                    <div
                      style={{
                        fontSize: "14px",
                        lineHeight: 1.6,
                        marginBottom: "8px",
                      }}
                    >
                      Sau khi nhận được thanh toán, Admin sẽ kiểm tra và kích
                      hoạt gói mới cho tài khoản của bạn.
                    </div>

                    <div style={{ fontSize: "14px", marginBottom: "16px" }}>
                      Trạng thái yêu cầu: <strong>ĐANG CHỜ XÁC NHẬN</strong>
                    </div>

                    <div
                      style={{ display: "flex", justifyContent: "flex-end" }}
                    >
                      <button
                        type="button"
                        onClick={() => setShowPaymentThankYou(false)}
                        style={{
                          border: "none",
                          borderRadius: "9px",
                          padding: "10px 18px",
                          background: "#15803d",
                          color: "#ffffff",
                          fontSize: "14px",
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                      >
                        Đóng
                      </button>
                    </div>
                  </div>
                )}

                {payment && !showPaymentThankYou && (
                  <div
                    style={{
                      marginTop: "16px",
                      padding: "16px 18px",
                      borderRadius: "12px",
                      border: "1px solid #fde68a",
                      background: "#fffbeb",
                      color: "#92400e",
                    }}
                  >
                    <div
                      style={{
                        fontSize: "15px",
                        fontWeight: 700,
                        marginBottom: "8px",
                      }}
                    >
                      Yêu cầu{" "}
                      {payment.paymentType === "RENEWAL"
                        ? "gia hạn"
                        : "nâng cấp"}
                    </div>
                    <div style={{ fontSize: "14px", marginBottom: "6px" }}>
                      Gói: <strong>{payment.planName}</strong>
                    </div>
                    <div style={{ fontSize: "14px" }}>
                      🟡 <strong>ĐANG CHỜ XÁC NHẬN</strong>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
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
              Đổi mật khẩu
            </h2>

            <div
              style={{
                display: "grid",
                gap: "14px",
              }}
            >
              <div
                style={{
                  position: "relative",
                }}
              >
                <input
                  type={showCurrentPassword ? "text" : "password"}
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  placeholder="Mật khẩu hiện tại"
                  style={{
                    width: "100%",
                    padding: "12px 44px 12px 14px",
                    border: "1px solid #dbe1ea",
                    borderRadius: "10px",
                    fontSize: "14px",
                    boxSizing: "border-box",
                  }}
                />

                <button
                  type="button"
                  onClick={() => setShowCurrentPassword((value) => !value)}
                  style={{
                    position: "absolute",
                    right: "10px",
                    top: "50%",
                    transform: "translateY(-50%)",
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    fontSize: "14px",
                    padding: "4px",
                  }}
                  aria-label={
                    showCurrentPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"
                  }
                >
                  {showCurrentPassword ? "Ẩn" : "Hiện"}
                </button>
              </div>

              <div
                style={{
                  position: "relative",
                }}
              >
                <input
                  type={showNewPassword ? "text" : "password"}
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="Mật khẩu mới"
                  style={{
                    width: "100%",
                    padding: "12px 44px 12px 14px",
                    border: "1px solid #dbe1ea",
                    borderRadius: "10px",
                    fontSize: "14px",
                    boxSizing: "border-box",
                  }}
                />

                <button
                  type="button"
                  onClick={() => setShowNewPassword((value) => !value)}
                  style={{
                    position: "absolute",
                    right: "10px",
                    top: "50%",
                    transform: "translateY(-50%)",
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    fontSize: "14px",
                    padding: "4px",
                  }}
                  aria-label={showNewPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"}
                >
                  {showNewPassword ? "Ẩn" : "Hiện"}
                </button>
              </div>
              {newPassword && (
                <div
                  style={{
                    marginTop: "-6px",
                    marginBottom: "2px",
                    fontSize: "13px",
                    lineHeight: 1.8,
                  }}
                >
                  <div
                    style={{
                      color: hasMinLength ? "#15803d" : "#dc2626",
                    }}
                  >
                    {hasMinLength ? "✓" : "✕"} Ít nhất 6 ký tự
                  </div>

                  <div
                    style={{
                      color: hasUppercase ? "#15803d" : "#dc2626",
                    }}
                  >
                    {hasUppercase ? "✓" : "✕"} Ít nhất 1 chữ hoa
                  </div>
                  <div
                    style={{
                      color: hasLowercase ? "#15803d" : "#dc2626",
                    }}
                  >
                    {hasLowercase ? "✓" : "✕"} Ít nhất 1 chữ thường
                  </div>

                  <div
                    style={{
                      color: hasNumber ? "#15803d" : "#dc2626",
                    }}
                  >
                    {hasNumber ? "✓" : "✕"} Ít nhất 1 chữ số
                  </div>

                  {isNewPasswordValid && (
                    <div
                      style={{
                        marginTop: "4px",
                        color: "#15803d",
                        fontWeight: 600,
                      }}
                    >
                      ✓ Mật khẩu hợp lệ
                    </div>
                  )}
                  {isSamePassword && (
                    <div
                      style={{
                        marginTop: "4px",
                        color: "#dc2626",
                        fontWeight: 600,
                      }}
                    >
                      ✕ Mật khẩu mới phải khác mật khẩu hiện tại
                    </div>
                  )}
                </div>
              )}
              <div
                style={{
                  position: "relative",
                }}
              >
                <input
                  type={showConfirmPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  placeholder="Nhập lại mật khẩu"
                  style={{
                    width: "100%",
                    padding: "12px 44px 12px 14px",
                    border: "1px solid #dbe1ea",
                    borderRadius: "10px",
                    fontSize: "14px",
                    boxSizing: "border-box",
                  }}
                />

                <button
                  type="button"
                  onClick={() => setShowConfirmPassword((value) => !value)}
                  style={{
                    position: "absolute",
                    right: "10px",
                    top: "50%",
                    transform: "translateY(-50%)",
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    fontSize: "14px",
                    padding: "4px",
                  }}
                  aria-label={
                    showConfirmPassword ? "Ẩn mật khẩu" : "Hiện mật khẩu"
                  }
                >
                  {showConfirmPassword ? "Ẩn" : "Hiện"}
                </button>
              </div>

              {passwordError && (
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: "8px",
                    background: "#fee2e2",
                    color: "#b91c1c",
                    fontSize: "14px",
                  }}
                >
                  {passwordError}
                </div>
              )}

              {passwordMessage && (
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: "8px",
                    background: "#dcfce7",
                    color: "#15803d",
                    fontSize: "14px",
                  }}
                >
                  {passwordMessage}
                </div>
              )}

              <button
                type="button"
                onClick={handleChangePassword}
                disabled={changingPassword || !canChangePassword}
                style={{
                  width: "fit-content",
                  padding: "11px 20px",
                  border: "none",
                  borderRadius: "10px",
                  background: canChangePassword ? "#2563eb" : "#94a3b8",
                  color: "#ffffff",
                  fontSize: "14px",
                  fontWeight: 600,
                  cursor:
                    changingPassword || !canChangePassword
                      ? "not-allowed"
                      : "pointer",
                  opacity: changingPassword || !canChangePassword ? 0.7 : 1,
                }}
              >
                {changingPassword ? "Đang đổi mật khẩu..." : "Đổi mật khẩu"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AccountPage;
