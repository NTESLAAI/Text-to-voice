import { useEffect, useState } from "react";

import { confirmAdminPayment, getAdminPayments } from "../../services/api";
import type { AdminPayment } from "../../services/api";

interface PaymentDetail {
  id: string;
  userName: string;
  email: string;
  type: string;
  plan: string;
  amount: string;
  transferCode: string;
  status: string;
  statusCode: string;
  provider: string;
  createdAt: string;
}

function formatAmount(amount: number, currency: string) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: currency || "VND",
  }).format(amount);
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("vi-VN");
}

function getPaymentTypeLabel(paymentType: string) {
  switch (paymentType) {
    case "NEW_PURCHASE":
      return "Mua mới";
    case "UPGRADE":
      return "Nâng cấp";
    case "RENEWAL":
      return "Gia hạn";
    default:
      return paymentType || "—";
  }
}

function getStatusLabel(status: string) {
  switch (status) {
    case "PENDING":
      return "Chờ thanh toán";
    case "USER_CONFIRMED":
      return "Đã báo thanh toán";
    case "PAID":
      return "Đã thanh toán";
    case "CANCELLED":
      return "Đã hủy";
    default:
      return status;
  }
}

function getStatusClass(status: string) {
  switch (status) {
    case "PAID":
      return "paid";
    case "CANCELLED":
      return "cancelled";
    case "USER_CONFIRMED":
      return "confirmed";
    default:
      return "pending";
  }
}

function toPaymentDetail(payment: AdminPayment): PaymentDetail {
  return {
    id: payment.id,
    userName: payment.user?.name || "—",
    email: payment.user?.email || "—",
    type: getPaymentTypeLabel(payment.paymentType),
    plan: payment.plan?.name || payment.plan?.code || "—",
    amount: formatAmount(payment.amount, payment.currency),
    transferCode: payment.transferCode || "—",
    status: getStatusLabel(payment.status),
    statusCode: payment.status,
    provider: payment.provider || "—",
    createdAt: formatDate(payment.createdAt),
  };
}

export default function AdminPayments() {
  const [payments, setPayments] = useState<PaymentDetail[]>([]);
  const [selectedPayment, setSelectedPayment] = useState<PaymentDetail | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const handleConfirmPayment = async () => {
    if (!selectedPayment) return;

    try {
      setConfirming(true);
      setError("");

      await confirmAdminPayment(selectedPayment.id);

      const data = await getAdminPayments();
      setPayments(data.map(toPaymentDetail));
      setSelectedPayment(null);
    } catch (err) {
      console.error(err);
      setError("Không thể xác nhận thanh toán.");
    } finally {
      setConfirming(false);
    }
  };

  useEffect(() => {
    let mounted = true;

    async function loadPayments() {
      try {
        setLoading(true);
        setError("");

        const data = await getAdminPayments();

        if (mounted) {
          setPayments(data.map(toPaymentDetail));
        }
      } catch (err) {
        console.error("ADMIN PAYMENTS ERROR:", err);

        if (mounted) {
          setError("Không thể tải danh sách thanh toán.");
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    }

    loadPayments();

    return () => {
      mounted = false;
    };
  }, []);

  return (
    <section className="admin-payments">
      <div className="admin-page-heading">
        <div>
          <h2>Quản lý thanh toán</h2>
          <p>Danh sách các giao dịch thanh toán của người dùng</p>
        </div>
      </div>

      {loading && (
        <div className="admin-empty-state">
          Đang tải danh sách thanh toán...
        </div>
      )}

      {!loading && error && <div className="admin-empty-state">{error}</div>}

      {!loading && !error && payments.length === 0 && (
        <div className="admin-empty-state">
          Chưa có giao dịch thanh toán nào.
        </div>
      )}

      {!loading && !error && payments.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-payments-table">
            <thead>
              <tr>
                <th>Tài khoản</th>
                <th>Loại giao dịch</th>
                <th>Gói</th>
                <th>Số tiền</th>
                <th>Mã chuyển khoản</th>
                <th>Trạng thái</th>
                <th>Ngày tạo</th>
                <th>Thao tác</th>
              </tr>
            </thead>

            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td>
                    <strong>{payment.userName}</strong>
                    <small>{payment.email}</small>
                  </td>

                  <td>{payment.type}</td>

                  <td>{payment.plan}</td>

                  <td>{payment.amount}</td>

                  <td>
                    <strong>{payment.transferCode}</strong>
                  </td>

                  <td>
                    <span
                      className={`admin-payment-status ${getStatusClass(
                        payment.status,
                      )}`}
                    >
                      {payment.status}
                    </span>
                  </td>

                  <td>{payment.createdAt}</td>

                  <td>
                    <button
                      type="button"
                      className="admin-action-button"
                      onClick={() => setSelectedPayment(payment)}
                    >
                      Xem
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedPayment && (
        <div
          className="admin-modal-backdrop"
          onClick={() => setSelectedPayment(null)}
        >
          <section
            className="admin-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="payment-detail-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="payment-detail-title">Chi tiết giao dịch</h3>

            <div className="admin-payment-detail">
              <div>
                <span>Tài khoản</span>
                <strong>{selectedPayment.userName}</strong>
              </div>

              <div>
                <span>Email</span>
                <strong>{selectedPayment.email}</strong>
              </div>

              <div>
                <span>Loại giao dịch</span>
                <strong>{selectedPayment.type}</strong>
              </div>

              <div>
                <span>Gói đăng ký</span>
                <strong>{selectedPayment.plan}</strong>
              </div>

              <div>
                <span>Số tiền</span>
                <strong>{selectedPayment.amount}</strong>
              </div>

              <div>
                <span>Mã chuyển khoản</span>
                <strong>{selectedPayment.transferCode}</strong>
              </div>

              <div>
                <span>Phương thức</span>
                <strong>{selectedPayment.provider}</strong>
              </div>

              <div>
                <span>Trạng thái</span>
                <strong>{selectedPayment.status}</strong>
              </div>

              <div>
                <span>Ngày tạo</span>
                <strong>{selectedPayment.createdAt}</strong>
              </div>
            </div>

            <div className="admin-modal-actions">
              <button
                type="button"
                className="admin-modal-cancel"
                onClick={() => setSelectedPayment(null)}
              >
                Đóng
              </button>

              {(selectedPayment.statusCode === "PENDING" ||
                selectedPayment.statusCode === "USER_CONFIRMED") && (
                <button
                  type="button"
                  className="admin-modal-confirm"
                  onClick={handleConfirmPayment}
                  disabled={confirming}
                >
                  {confirming ? "Đang xác nhận..." : "Xác nhận đã nhận tiền"}
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
