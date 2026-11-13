import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  confirmAdminPayment,
  getAdminPayments,
  getUnmatchedTransactions,
} from "../../services/api";
import type { AdminPayment } from "../../services/api";

interface PaymentDetail {
  receivingBankAccount: AdminPayment["receivingBankAccount"];
  spendabilityStatus: AdminPayment["spendabilityStatus"];
  spendableAmount: AdminPayment["spendableAmount"];
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
  paidAt: string | null;
  matchedAmount: number;
  surplusAmount: number;
  transactions: AdminPayment["transactions"];
  currency: string;
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
    receivingBankAccount: payment.receivingBankAccount,
    spendabilityStatus: payment.spendabilityStatus,
    spendableAmount: payment.spendableAmount,
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
    paidAt: payment.paidAt ? formatDate(payment.paidAt) : null,
    matchedAmount: payment.matchedAmount,
    surplusAmount: payment.surplusAmount,
    transactions: payment.transactions,
    currency: payment.currency,
  };
}

export default function AdminPayments() {
  const { t } = useTranslation();
  const [referenceSearch, setReferenceSearch] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [unmatched, setUnmatched] = useState<
    Awaited<ReturnType<typeof getUnmatchedTransactions>>
  >([]);
  const [payments, setPayments] = useState<PaymentDetail[]>([]);
  const [selectedPayment, setSelectedPayment] = useState<PaymentDetail | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  async function searchTransactions() {
    setSearching(true);
    setSearchError("");
    try {
      setUnmatched(await getUnmatchedTransactions(referenceSearch.trim()));
    } catch {
      setSearchError("Không thể tra cứu giao dịch. Vui lòng thử lại.");
    } finally {
      setSearching(false);
    }
  }
  const handleConfirmPayment = async () => {
    if (!selectedPayment) return;

    try {
      setConfirming(true);
      setError("");

      await confirmAdminPayment(selectedPayment.id);

      const data = await getAdminPayments();
      setPayments(data.map(toPaymentDetail));
      setSelectedPayment(null);
    } catch {
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

        const [data, unmatchedData] = await Promise.all([
          getAdminPayments(),
          getUnmatchedTransactions(),
        ]);

        if (mounted) {
          setPayments(data.map(toPaymentDetail));
          setUnmatched(unmatchedData);
        }
      } catch {
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

      {!loading && !error && (
        <details>
          <summary>
            Giao dịch cần đối soát ({unmatched.length}, tối đa 100 kết quả)
          </summary>
          <label>
            Mã giao dịch ngân hàng{" "}
            <input
              value={referenceSearch}
              maxLength={128}
              onChange={(event) => setReferenceSearch(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={searching}
            onClick={() => void searchTransactions()}
          >
            {searching ? "Đang tra cứu..." : "Tra cứu"}
          </button>
          {searchError && <p role="alert">{searchError}</p>}
          <p>
            Các giao dịch này chưa hoàn tất đối soát. Không xác nhận đơn chỉ dựa
            vào số tiền; cần kiểm tra mã giao dịch, đơn nhận tiền và currency
            trước khi xử lý thủ công.
          </p>
          <ul>
            {unmatched.map((transaction) => (
              <li key={transaction.id}>
                {transaction.providerTransactionId || transaction.id} ·{" "}
                {transaction.provider} ·{" "}
                {formatAmount(transaction.amount, transaction.currency)} ·{" "}
                {transaction.status} · Đơn:{" "}
                {transaction.paymentId || "Chưa liên kết"} · Nội dung:{" "}
                {transaction.reference || "—"}
              </li>
            ))}
          </ul>
        </details>
      )}

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
                <span>{t("bankPolicy.account")}</span>
                <strong>
                  {selectedPayment.receivingBankAccount
                    ? `${selectedPayment.receivingBankAccount.code} · ${selectedPayment.receivingBankAccount.accountNumberMasked} · ${selectedPayment.receivingBankAccount.policy}`
                    : t("bankPolicy.unknown")}
                </strong>
              </div>
              <div>
                <span>{t("bankPolicy.spendable")}</span>
                <strong>
                  {selectedPayment.spendabilityStatus === "VERIFIED" &&
                  selectedPayment.spendableAmount != null
                    ? formatAmount(
                        Number(selectedPayment.spendableAmount),
                        selectedPayment.currency,
                      )
                    : t("bankPolicy.unverified")}
                </strong>
              </div>
              {selectedPayment.spendabilityStatus !== "VERIFIED" && (
                <p role="status">{t("bankPolicy.reviewRequired")}</p>
              )}
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
                <span>Tổng tiền đã đối soát</span>
                <strong>
                  {formatAmount(
                    selectedPayment.matchedAmount,
                    selectedPayment.currency,
                  )}
                </strong>
              </div>

              <div>
                <span>Tiền chuyển thừa</span>
                <strong
                  className={
                    selectedPayment.surplusAmount > 0
                      ? "admin-payment-surplus"
                      : undefined
                  }
                >
                  {formatAmount(
                    selectedPayment.surplusAmount,
                    selectedPayment.currency,
                  )}
                </strong>
              </div>
              <div className="admin-payment-transactions">
                <h4>Giao dịch ngân hàng</h4>

                {selectedPayment.transactions.length === 0 ? (
                  <p>Chưa có giao dịch ngân hàng liên kết.</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Số tiền</th>
                        <th>Trạng thái</th>
                        <th>Thời điểm đối soát</th>
                        <th>Nội dung</th>
                      </tr>
                    </thead>

                    <tbody>
                      {selectedPayment.transactions.map((transaction) => (
                        <tr key={transaction.id}>
                          <td>
                            {formatAmount(
                              transaction.amount,
                              transaction.currency,
                            )}
                          </td>
                          <td>{transaction.status}</td>
                          <td>
                            {transaction.matchedAt
                              ? formatDate(transaction.matchedAt)
                              : "—"}
                          </td>
                          <td>
                            {transaction.reference || transaction.note || "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
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
              <div>
                <span>Thời điểm ghi nhận thanh toán</span>
                <strong>
                  {selectedPayment.paidAt || "Chưa ghi nhận PAID"}
                </strong>
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
                  disabled={
                    confirming ||
                    selectedPayment.spendabilityStatus !== "VERIFIED"
                  }
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
