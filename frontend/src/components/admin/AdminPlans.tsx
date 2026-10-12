import { useEffect, useState } from "react";
import api from "../../services/api";

interface Plan {
  id: string;
  code: string;
  name: string;
  price: number;
  currency: string;
  durationDays: number;
  characterLimit: number;
  isActive: boolean;
}

function formatPrice(price: number, currency: string) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: currency || "VND",
  }).format(price);
}

export default function AdminPlans() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [editingPlan, setEditingPlan] = useState<Plan | null>(null);
  const [originalPlan, setOriginalPlan] = useState<Plan | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  const hasChanges = (original: Plan, edited: Plan) =>
    original.name !== edited.name ||
    Number(original.price) !== Number(edited.price) ||
    Number(original.durationDays) !== Number(edited.durationDays) ||
    Number(original.characterLimit) !== Number(edited.characterLimit) ||
    original.isActive !== edited.isActive;

  const isPlanChanged =
    editingPlan !== null &&
    originalPlan !== null &&
    hasChanges(originalPlan, editingPlan);

  async function loadPlans() {
    try {
      setLoading(true);
      setError("");

      const response = await api.get<Plan[]>("/admin/plans");
      setPlans(response.data);
    } catch (err) {
      console.error("ADMIN PLANS ERROR:", err);
      setError("Không thể tải danh sách gói cước.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadPlans();
  }, []);

  async function savePlanDirectly() {
    if (!editingPlan || !isPlanChanged) return;

    try {
      setSavingId(editingPlan.id);
      setError("");

      const response = await api.patch<Plan>(`/admin/plans/${editingPlan.id}`, {
        name: editingPlan.name,
        price: editingPlan.price,
        durationDays: editingPlan.durationDays,
        characterLimit: editingPlan.characterLimit,
        isActive: editingPlan.isActive,
      });

      setPlans((current) =>
        current.map((plan) =>
          plan.id === response.data.id ? response.data : plan,
        ),
      );

      setEditingPlan(null);
      setOriginalPlan(null);
      setShowConfirm(false);
    } catch (err) {
      console.error("UPDATE PLAN ERROR:", err);
      setError("Không thể cập nhật gói cước. Vui lòng kiểm tra dữ liệu.");
    } finally {
      setSavingId(null);
    }
  }

  function savePlan() {
    if (!editingPlan || !isPlanChanged || savingId !== null) return;

    setShowConfirm(true);
  }

  async function confirmSavePlan() {
    await savePlanDirectly();
  }

  return (
    <section className="admin-payments">
      <div className="admin-page-heading">
        <div>
          <h2>Quản lý gói cước</h2>
          <p>Quản lý giá, hạn mức ký tự, thời hạn và trạng thái các gói.</p>
        </div>
      </div>

      {loading && (
        <div className="admin-empty-state">Đang tải danh sách gói cước...</div>
      )}

      {!loading && error && <div className="admin-empty-state">{error}</div>}

      {!loading && !error && plans.length === 0 && (
        <div className="admin-empty-state">Chưa có gói cước nào.</div>
      )}

      {!loading && plans.length > 0 && (
        <div className="admin-table-wrap">
          <table className="admin-payments-table">
            <thead>
              <tr>
                <th>Mã gói</th>
                <th>Tên gói</th>
                <th>Giá</th>
                <th>Hạn mức ký tự</th>
                <th>Thời hạn</th>
                <th>Trạng thái</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => (
                <tr key={plan.id}>
                  <td>{plan.code}</td>
                  <td>{plan.name}</td>
                  <td>{formatPrice(plan.price, plan.currency)}</td>
                  <td>{plan.characterLimit.toLocaleString("vi-VN")}</td>
                  <td>{plan.durationDays} ngày</td>
                  <td>{plan.isActive ? "Đang hoạt động" : "Đã tắt"}</td>
                  <td>
                    <button
                      type="button"
                      className="admin-action-button"
                      onClick={() => {
                        setOriginalPlan({ ...plan });
                        setEditingPlan({ ...plan });
                      }}
                    >
                      Chỉnh sửa
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editingPlan && (
        <div
          className="admin-modal-backdrop"
          onClick={() => setEditingPlan(null)}
        >
          <section
            className="admin-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-plan-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="edit-plan-title">Chỉnh sửa gói {editingPlan.code}</h3>

            <div className="admin-payment-detail">
              <label>
                Tên gói
                <input
                  value={editingPlan.name}
                  onChange={(event) =>
                    setEditingPlan({
                      ...editingPlan,
                      name: event.target.value,
                    })
                  }
                />
              </label>

              <label>
                Giá (VND)
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={editingPlan.price}
                  onChange={(event) =>
                    setEditingPlan({
                      ...editingPlan,
                      price: Number(event.target.value),
                    })
                  }
                />
              </label>

              <label>
                Hạn mức ký tự
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={editingPlan.characterLimit}
                  onChange={(event) =>
                    setEditingPlan({
                      ...editingPlan,
                      characterLimit: Number(event.target.value),
                    })
                  }
                />
              </label>

              <label>
                Thời hạn (ngày)
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={editingPlan.durationDays}
                  onChange={(event) =>
                    setEditingPlan({
                      ...editingPlan,
                      durationDays: Number(event.target.value),
                    })
                  }
                />
              </label>

              <label>
                <input
                  type="checkbox"
                  checked={editingPlan.isActive}
                  onChange={(event) =>
                    setEditingPlan({
                      ...editingPlan,
                      isActive: event.target.checked,
                    })
                  }
                />
                Gói đang hoạt động
              </label>
            </div>

            <div className="admin-modal-actions">
              <button
                type="button"
                className="admin-modal-cancel"
                onClick={() => setEditingPlan(null)}
                disabled={savingId !== null}
              >
                Hủy
              </button>
              <button
                type="button"
                className={`admin-modal-confirm ${
                  isPlanChanged && savingId === null
                    ? "is-enabled"
                    : "is-disabled"
                }`}
                onClick={() => void savePlan()}
                disabled={savingId !== null || !isPlanChanged}
              >
                {savingId === editingPlan.id ? "Đang lưu..." : "Lưu thay đổi"}
              </button>
            </div>
          </section>
        </div>
      )}

      {showConfirm && editingPlan && originalPlan && (
        <div
          className="admin-modal-backdrop"
          onClick={() => {
            if (savingId === null) setShowConfirm(false);
          }}
        >
          <section
            className="admin-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-plan-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h3 id="confirm-plan-title">Xác nhận cập nhật gói cước</h3>

            <p>
              Bạn có chắc chắn muốn cập nhật gói {editingPlan.code}? Vui lòng
              kiểm tra các thay đổi dưới đây.
            </p>

            <div className="admin-payment-detail">
              {originalPlan.name !== editingPlan.name && (
                <div>
                  <strong>Tên gói</strong>
                  <p>Cũ: {originalPlan.name}</p>
                  <p>Mới: {editingPlan.name}</p>
                </div>
              )}

              {Number(originalPlan.price) !== Number(editingPlan.price) && (
                <div>
                  <strong>Giá gói</strong>
                  <p>
                    Cũ: {formatPrice(originalPlan.price, originalPlan.currency)}
                  </p>
                  <p>
                    Mới: {formatPrice(editingPlan.price, editingPlan.currency)}
                  </p>
                </div>
              )}

              {Number(originalPlan.characterLimit) !==
                Number(editingPlan.characterLimit) && (
                <div>
                  <strong>Hạn mức ký tự</strong>
                  <p>
                    Cũ: {originalPlan.characterLimit.toLocaleString("vi-VN")}
                  </p>
                  <p>
                    Mới: {editingPlan.characterLimit.toLocaleString("vi-VN")}
                  </p>
                </div>
              )}

              {Number(originalPlan.durationDays) !==
                Number(editingPlan.durationDays) && (
                <div>
                  <strong>Thời hạn</strong>
                  <p>Cũ: {originalPlan.durationDays} ngày</p>
                  <p>Mới: {editingPlan.durationDays} ngày</p>
                </div>
              )}

              {originalPlan.isActive !== editingPlan.isActive && (
                <div>
                  <strong>Trạng thái</strong>
                  <p>
                    Cũ: {originalPlan.isActive ? "Đang hoạt động" : "Đã tắt"}
                  </p>
                  <p>
                    Mới: {editingPlan.isActive ? "Đang hoạt động" : "Đã tắt"}
                  </p>
                </div>
              )}
            </div>

            <div className="admin-modal-actions">
              <button
                type="button"
                className="admin-modal-cancel"
                onClick={() => setShowConfirm(false)}
                disabled={savingId !== null}
              >
                Quay lại
              </button>

              <button
                type="button"
                className="admin-modal-confirm is-enabled"
                onClick={() => void confirmSavePlan()}
                disabled={savingId !== null}
              >
                {savingId === editingPlan.id
                  ? "Đang cập nhật..."
                  : "Xác nhận cập nhật"}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
