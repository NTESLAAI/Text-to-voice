
import { useCallback, useEffect, useState } from "react";
import {
  changeAdminPromotionStatus,
  createAdminPromotion,
  getAdminPromotions,
  getPromotionAvailablePlans,
  updateAdminPromotion,
  type AdminPromotion,
  type CreatePromotionInput,
  type PromotionAvailablePlan,
  type PromotionPlanPriceInput,
  type PromotionStatus,
} from "../../services/api";

type PromotionForm = {
  title: string;
  message: string;
  startsAt: string;
  endsAt: string;
  planPrices: PromotionPlanPriceInput[];
};

function toLocalDateTimeInput(value?: string): string {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000)
    .toISOString()
    .slice(0, 16);
}

function toIsoDate(value: string): string {
  return new Date(value).toISOString();
}

function createEmptyForm(): PromotionForm {
  const now = new Date();
  const start = new Date(now.getTime() + 5 * 60_000);
  const end = new Date(now.getTime() + 7 * 24 * 60 * 60_000);

  return {
    title: "",
    message: "",
    startsAt: toLocalDateTimeInput(start.toISOString()),
    endsAt: toLocalDateTimeInput(end.toISOString()),
    planPrices: [],
  };
}

function getErrorMessage(error: unknown): string {
  const err = error as {
    response?: {
      data?: {
        message?: string | string[];
      };
    };
    message?: string;
  };

  const message = err.response?.data?.message;

  if (Array.isArray(message)) return message.join("; ");
  if (typeof message === "string") return message;
  if (err.message) return err.message;

  return "Đã xảy ra lỗi. Vui lòng thử lại.";
}

function formatDate(value: string): string {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString("vi-VN", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function formatPrice(value: number): string {
  return `${Number(value).toLocaleString("vi-VN")} đ`;
}

function getStatusLabel(status: PromotionStatus): string {
  switch (status) {
    case "DRAFT":
      return "Bản nháp";
    case "ACTIVE":
      return "Đang kích hoạt";
    case "PAUSED":
      return "Tạm dừng";
    case "ENDED":
      return "Đã kết thúc";
    default:
      return status;
  }
}

function canEditPromotion(promotion: AdminPromotion): boolean {
  const now = Date.now();
  const effectiveStatus = promotion.effectiveStatus ?? promotion.status;

  if (effectiveStatus === "ENDED") return false;
  if (new Date(promotion.endsAt).getTime() <= now) return false;

  // Backend không cho sửa chương trình ACTIVE đã bắt đầu.
  if (
    promotion.status === "ACTIVE" &&
    new Date(promotion.startsAt).getTime() <= now
  ) {
    return false;
  }

  return true;
}

function canActivatePromotion(promotion: AdminPromotion): boolean {
  const now = Date.now();
  const effectiveStatus = promotion.effectiveStatus ?? promotion.status;

  if (effectiveStatus === "ENDED") return false;
  if (promotion.status === "ACTIVE") return false;
  if (new Date(promotion.endsAt).getTime() <= now) return false;

  return true;
}

export default function AdminPromotions() {
  const [promotions, setPromotions] = useState<AdminPromotion[]>([]);
  const [plans, setPlans] = useState<PromotionAvailablePlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingPromotion, setEditingPromotion] =
    useState<AdminPromotion | null>(null);
  const [form, setForm] = useState<PromotionForm>(createEmptyForm);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [promotionData, planData] = await Promise.all([
        getAdminPromotions(),
        getPromotionAvailablePlans(),
      ]);

      setPromotions(promotionData);
      setPlans(planData);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  function openCreateForm() {
    setEditingPromotion(null);
    setForm(createEmptyForm());
    setError("");
    setSuccess("");
    setShowForm(true);
  }

  function openEditForm(promotion: AdminPromotion) {
    setEditingPromotion(promotion);
    setForm({
      title: promotion.title,
      message: promotion.message,
      startsAt: toLocalDateTimeInput(promotion.startsAt),
      endsAt: toLocalDateTimeInput(promotion.endsAt),
      planPrices: promotion.planPrices.map((item) => ({
        planId: item.planId,
        promotionalPrice: Number(item.promotionalPrice),
      })),
    });
    setError("");
    setSuccess("");
    setShowForm(true);
  }

  function closeForm() {
    if (saving) return;

    setShowForm(false);
    setEditingPromotion(null);
  }

  function updateFormField(
    field: "title" | "message" | "startsAt" | "endsAt",
    value: string,
  ) {
    setForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function togglePlan(plan: PromotionAvailablePlan, checked: boolean) {
    setForm((current) => {
      if (checked) {
        if (current.planPrices.some((item) => item.planId === plan.id)) {
          return current;
        }

        return {
          ...current,
          planPrices: [
            ...current.planPrices,
            {
              planId: plan.id,
              promotionalPrice: Number(plan.price),
            },
          ],
        };
      }

      return {
        ...current,
        planPrices: current.planPrices.filter(
          (item) => item.planId !== plan.id,
        ),
      };
    });
  }

  function updatePlanPrice(planId: string, value: string) {
    setForm((current) => ({
      ...current,
      planPrices: current.planPrices.map((item) =>
        item.planId === planId
          ? {
              ...item,
              promotionalPrice: value === "" ? 0 : Number(value),
            }
          : item,
      ),
    }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess("");

    if (!form.title.trim()) {
      setError("Vui lòng nhập tiêu đề chương trình.");
      return;
    }

    if (!form.message.trim()) {
      setError("Vui lòng nhập nội dung chương trình.");
      return;
    }

    if (!form.startsAt || !form.endsAt) {
      setError("Vui lòng nhập thời gian bắt đầu và kết thúc.");
      return;
    }

    const startTime = new Date(form.startsAt).getTime();
    const endTime = new Date(form.endsAt).getTime();

    if (
      Number.isNaN(startTime) ||
      Number.isNaN(endTime) ||
      endTime <= startTime
    ) {
      setError("Thời gian kết thúc phải sau thời gian bắt đầu.");
      return;
    }

    if (form.planPrices.length === 0) {
      setError("Vui lòng chọn ít nhất một gói dịch vụ.");
      return;
    }

    for (const item of form.planPrices) {
      const plan = plans.find((candidate) => candidate.id === item.planId);

      if (!plan) {
        setError("Có gói dịch vụ không còn khả dụng. Vui lòng tải lại.");
        return;
      }

      if (
        !Number.isFinite(item.promotionalPrice) ||
        item.promotionalPrice < 0 ||
        item.promotionalPrice > Number(plan.price)
      ) {
        setError(
          `Giá khuyến mại của gói "${plan.name}" phải từ 0 đến ${formatPrice(Number(plan.price))}.`,
        );
        return;
      }
    }

    const payload: CreatePromotionInput = {
      title: form.title.trim(),
      message: form.message.trim(),
      startsAt: toIsoDate(form.startsAt),
      endsAt: toIsoDate(form.endsAt),
      planPrices: form.planPrices.map((item) => ({
        planId: item.planId,
        promotionalPrice: Number(item.promotionalPrice),
      })),
    };

    setSaving(true);

    try {
      if (editingPromotion) {
        await updateAdminPromotion(editingPromotion.id, payload);
        setSuccess("Đã cập nhật chương trình khuyến mại.");
      } else {
        await createAdminPromotion(payload);
        setSuccess("Đã tạo chương trình khuyến mại ở trạng thái bản nháp.");
      }

      setShowForm(false);
      setEditingPromotion(null);
      await loadData();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(
    promotion: AdminPromotion,
    nextStatus: "ACTIVE" | "PAUSED",
  ) {
    const action =
      nextStatus === "ACTIVE" ? "kích hoạt" : "tạm dừng";

    const confirmed = window.confirm(
      `Anh có chắc chắn muốn ${action} chương trình "${promotion.title}" không?`,
    );

    if (!confirmed) return;

    setError("");
    setSuccess("");

    try {
      await changeAdminPromotionStatus(promotion.id, nextStatus);
      setSuccess(
        nextStatus === "ACTIVE"
          ? "Đã gửi yêu cầu kích hoạt chương trình."
          : "Đã tạm dừng chương trình.",
      );

      // API đổi trạng thái trả về bản ghi không kèm planPrices,
      // vì vậy tải lại toàn bộ danh sách sau khi cập nhật.
      await loadData();
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  return (
    <section className="admin-promotions">
      <div className="admin-page-heading">
        <div>
          <h2>Quản lý khuyến mại</h2>
          <p>
            Tạo chương trình, thiết lập thời gian và giá khuyến mại cho từng
            gói dịch vụ.
          </p>
        </div>

        <button
          type="button"
          className="admin-action-button admin-promotion-create-button"
          onClick={openCreateForm}
          disabled={loading || plans.length === 0}
        >
          + Tạo khuyến mại
        </button>
      </div>

      {error && !showForm && (
        <div className="admin-promotion-alert admin-promotion-alert-error">
          {error}
        </div>
      )}

      {success && (
        <div className="admin-promotion-alert admin-promotion-alert-success">
          {success}
        </div>
      )}

      {loading ? (
        <p>Đang tải dữ liệu khuyến mại...</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-payments-table admin-promotions-table">
            <thead>
              <tr>
                <th>Chương trình</th>
                <th>Thời gian</th>
                <th>Gói và giá khuyến mại</th>
                <th>Trạng thái</th>
                <th>Thao tác</th>
              </tr>
            </thead>

            <tbody>
              {promotions.length === 0 ? (
                <tr>
                  <td colSpan={5} className="admin-promotion-empty">
                    Chưa có chương trình khuyến mại nào.
                  </td>
                </tr>
              ) : (
                promotions.map((promotion) => {
                  const displayStatus =
                    promotion.effectiveStatus ?? promotion.status;
                  const editable = canEditPromotion(promotion);
                  const activatable = canActivatePromotion(promotion);

                  return (
                    <tr key={promotion.id}>
                      <td>
                        <div className="admin-promotion-title">
                          {promotion.title}
                        </div>
                        <div className="admin-promotion-message">
                          {promotion.message}
                        </div>
                      </td>

                      <td>
                        <div>
                          <strong>Từ:</strong>{" "}
                          {formatDate(promotion.startsAt)}
                        </div>
                        <div>
                          <strong>Đến:</strong>{" "}
                          {formatDate(promotion.endsAt)}
                        </div>
                      </td>

                      <td>
                        {promotion.planPrices.map((item) => (
                          <div
                            key={item.planId}
                            className="admin-promotion-price-row"
                          >
                            <span>{item.plan.name}</span>
                            <strong>
                              {formatPrice(Number(item.promotionalPrice))}
                            </strong>
                          </div>
                        ))}
                      </td>

                      <td>
                        <span
                          className={`admin-promotion-status admin-promotion-status-${displayStatus.toLowerCase()}`}
                        >
                          {getStatusLabel(displayStatus)}
                        </span>
                      </td>

                      <td>
                        <div className="admin-promotion-actions">
                          {editable && (
                            <button
                              type="button"
                              className="admin-action-button"
                              onClick={() => openEditForm(promotion)}
                            >
                              Sửa
                            </button>
                          )}

                          {activatable && (
                            <button
                              type="button"
                              className="admin-action-button"
                              onClick={() =>
                                void handleStatusChange(promotion, "ACTIVE")
                              }
                            >
                              Kích hoạt
                            </button>
                          )}

                          {promotion.status === "ACTIVE" &&
                            displayStatus !== "ENDED" && (
                              <button
                                type="button"
                                className="admin-action-button admin-promotion-pause"
                                onClick={() =>
                                  void handleStatusChange(promotion, "PAUSED")
                                }
                              >
                                Tạm dừng
                              </button>
                            )}

                          {!editable &&
                            !activatable &&
                            !(
                              promotion.status === "ACTIVE" &&
                              displayStatus !== "ENDED"
                            ) && <span>—</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <div className="admin-modal-backdrop">
          <div
            className="admin-confirm-modal admin-promotion-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="admin-promotion-form-title"
          >
            <h3 id="admin-promotion-form-title">
              {editingPromotion
                ? "Sửa chương trình khuyến mại"
                : "Tạo chương trình khuyến mại"}
            </h3>

            <form onSubmit={handleSubmit}>
              {error && (
                <div className="admin-promotion-alert admin-promotion-alert-error">
                  {error}
                </div>
              )}

              <div className="admin-promotion-field">
                <label htmlFor="promotion-title">Tiêu đề chương trình</label>
                <input
                  id="promotion-title"
                  type="text"
                  value={form.title}
                  onChange={(event) =>
                    updateFormField("title", event.target.value)
                  }
                  maxLength={200}
                  required
                />
              </div>

              <div className="admin-promotion-field">
                <label htmlFor="promotion-message">Nội dung khuyến mại</label>
                <textarea
                  id="promotion-message"
                  value={form.message}
                  onChange={(event) =>
                    updateFormField("message", event.target.value)
                  }
                  rows={4}
                  required
                />
              </div>

              <div className="admin-promotion-date-grid">
                <div className="admin-promotion-field">
                  <label htmlFor="promotion-starts-at">Bắt đầu</label>
                  <input
                    id="promotion-starts-at"
                    type="datetime-local"
                    value={form.startsAt}
                    onChange={(event) =>
                      updateFormField("startsAt", event.target.value)
                    }
                    required
                  />
                </div>

                <div className="admin-promotion-field">
                  <label htmlFor="promotion-ends-at">Kết thúc</label>
                  <input
                    id="promotion-ends-at"
                    type="datetime-local"
                    value={form.endsAt}
                    onChange={(event) =>
                      updateFormField("endsAt", event.target.value)
                    }
                    min={form.startsAt || undefined}
                    required
                  />
                </div>
              </div>

              <div className="admin-promotion-field">
                <label>Gói dịch vụ và giá khuyến mại</label>
                <p className="admin-promotion-hint">
                  Chọn ít nhất một gói. Giá khuyến mại không được vượt quá giá
                  gốc của gói.
                </p>

                {plans.length === 0 ? (
                  <p>Không có gói dịch vụ đang hoạt động để lựa chọn.</p>
                ) : (
                  <div className="admin-promotion-plan-list">
                    {plans.map((plan) => {
                      const selected = form.planPrices.find(
                        (item) => item.planId === plan.id,
                      );

                      return (
                        <div
                          key={plan.id}
                          className="admin-promotion-plan-row"
                        >
                          <label className="admin-promotion-plan-checkbox">
                            <input
                              type="checkbox"
                              checked={Boolean(selected)}
                              onChange={(event) =>
                                togglePlan(plan, event.target.checked)
                              }
                            />
                            <span>
                              <strong>{plan.name}</strong>
                              <small>
                                Giá gốc: {formatPrice(Number(plan.price))}
                              </small>
                            </span>
                          </label>

                          {selected && (
                            <div className="admin-promotion-price-input">
                              <label htmlFor={`promotion-price-${plan.id}`}>
                                Giá khuyến mại
                              </label>
                              <input
                                id={`promotion-price-${plan.id}`}
                                type="number"
                                min={0}
                                max={Number(plan.price)}
                                step="1"
                                value={selected.promotionalPrice}
                                onChange={(event) =>
                                  updatePlanPrice(
                                    plan.id,
                                    event.target.value,
                                  )
                                }
                                required
                              />
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="admin-modal-actions">
                <button
                  type="button"
                  className="admin-modal-cancel"
                  onClick={closeForm}
                  disabled={saving}
                >
                  Hủy
                </button>

                <button
                  type="submit"
                  className="admin-modal-confirm"
                  disabled={saving || plans.length === 0}
                >
                  {saving
                    ? "Đang lưu..."
                    : editingPromotion
                      ? "Lưu thay đổi"
                      : "Tạo bản nháp"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
