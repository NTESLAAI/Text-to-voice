import { useEffect, useState } from "react";
import { getAdminUsers, type AdminUser } from "../../services/adminApi";

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("vi-VN");
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("vi-VN").format(value);
}

function UserQuota({ user }: { user: AdminUser }) {
  if (!user.subscription) return <span className="admin-muted">—</span>;

  return (
    <span className="admin-quota">
      {formatNumber(user.subscription.quotaRemaining)}
      <small> / {formatNumber(user.subscription.quotaGranted)}</small>
    </span>
  );
}

export default function AdminUsers() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openResetFor, setOpenResetFor] = useState<string | null>(null);

  const [resetDialog, setResetDialog] = useState<{
    user: AdminUser;
    type: "quota" | "expiry";
  } | null>(null);
  const [deleteUser, setDeleteUser] = useState<AdminUser | null>(null);

  const openResetDialog = (user: AdminUser, type: "quota" | "expiry") => {
    setOpenResetFor(null);
    setResetDialog({ user, type });
  };

  useEffect(() => {
    let cancelled = false;

    async function loadUsers() {
      try {
        setLoading(true);
        setError("");
        const data = await getAdminUsers();

        if (!cancelled) setUsers(data);
      } catch (err) {
        console.error("Không thể tải danh sách người dùng:", err);
        if (!cancelled) {
          setError("Không thể tải danh sách người dùng. Vui lòng thử lại.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadUsers();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <div className="admin-state">Đang tải danh sách người dùng...</div>;
  }

  if (error) {
    return <div className="admin-state admin-error">{error}</div>;
  }

  return (
    <section className="admin-users">
      <div className="admin-page-heading">
        <div>
          <h2>Quản lý người dùng</h2>
          <p>Tổng số: {users.length} tài khoản</p>
        </div>
      </div>

      {users.length === 0 ? (
        <div className="admin-state">Chưa có người dùng nào.</div>
      ) : (
        <>
          <div className="admin-table-wrap">
            <table className="admin-users-table">
              <thead>
                <tr>
                  <th>Tài khoản</th>
                  <th>Email</th>
                  <th>Gói</th>
                  <th>Trạng thái</th>
                  <th>Ngày hết hạn</th>
                  <th>Quota còn lại</th>
                  <th>Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id}>
                    <td className="admin-account-cell">
                      <strong>{user.name || "Chưa cập nhật tên"}</strong>
                      <small>Tạo ngày: {formatDate(user.createdAt)}</small>
                    </td>
                    <td>{user.email}</td>
                    <td>
                      {user.subscription ? (
                        <>{user.subscription.plan.name}</>
                      ) : (
                        <span className="admin-muted">—</span>
                      )}
                    </td>
                    <td>
                      {user.subscription ? (
                        <span className="admin-status">
                          {user.subscription.status}
                        </span>
                      ) : (
                        <span className="admin-muted">—</span>
                      )}
                    </td>
                    <td>
                      {user.subscription
                        ? formatDate(user.subscription.expiresAt)
                        : "—"}
                    </td>
                    <td>
                      <UserQuota user={user} />
                    </td>
                    <td className="admin-actions-cell">
                      <div className="admin-reset-menu-wrap">
                        <button
                          type="button"
                          className="admin-action-button"
                          onClick={() =>
                            setOpenResetFor(
                              openResetFor === user.id ? null : user.id,
                            )
                          }
                          aria-expanded={openResetFor === user.id}
                        >
                          Reset <span aria-hidden="true">▾</span>
                        </button>

                        {openResetFor === user.id && (
                          <div className="admin-reset-menu">
                            <button
                              type="button"
                              onClick={() => openResetDialog(user, "quota")}
                            >
                              Quota
                            </button>
                            <button
                              type="button"
                              onClick={() => openResetDialog(user, "expiry")}
                            >
                              Hạn sử dụng
                            </button>
                          </div>
                        )}
                      </div>
                      {user.role.toUpperCase() !== "ADMIN" && (
                        <button
                          type="button"
                          className="admin-delete-button"
                          onClick={() => setDeleteUser(user)}
                        >
                          Xóa
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="admin-user-cards">
            {users.map((user) => (
              <article className="admin-user-card" key={user.id}>
                <div className="admin-card-heading">
                  <strong>{user.name || "Chưa cập nhật tên"}</strong>
                  <span>{user.email}</span>
                </div>

                <div className="admin-card-details">
                  <div>
                    <span>Gói</span>
                    <strong>
                      {user.subscription?.plan.name || "Chưa có gói"}
                    </strong>
                  </div>
                  <div>
                    <span>Trạng thái</span>
                    <strong>{user.subscription?.status || "—"}</strong>
                  </div>
                  <div>
                    <span>Ngày hết hạn</span>
                    <strong>
                      {user.subscription
                        ? formatDate(user.subscription.expiresAt)
                        : "—"}
                    </strong>
                  </div>
                  <div>
                    <span>Quota còn lại</span>
                    <strong>
                      <UserQuota user={user} />
                    </strong>
                  </div>
                </div>

                <small className="admin-card-created">
                  Tạo ngày: {formatDate(user.createdAt)}
                </small>
              </article>
            ))}
          </div>
        </>
      )}

      {resetDialog && (
        <div
          className="admin-modal-backdrop"
          onClick={() => setResetDialog(null)}
        >
          <section
            className="admin-confirm-modal"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>
              Xác nhận Reset{" "}
              {resetDialog.type === "quota" ? "Quota" : "Hạn sử dụng"}
            </h3>

            <p>
              Bạn đang chọn Reset{" "}
              {resetDialog.type === "quota" ? "Quota" : "Hạn sử dụng"} cho tài
              khoản{" "}
              <strong>
                {resetDialog.user.name ||
                  resetDialog.user.email ||
                  resetDialog.user.id}
              </strong>
              .
            </p>

            <div className="admin-modal-actions">
              <button
                type="button"
                className="admin-modal-cancel"
                onClick={() => setResetDialog(null)}
              >
                Hủy
              </button>

              <button
                type="button"
                className="admin-modal-confirm"
                onClick={() => setResetDialog(null)}
              >
                Xác nhận
              </button>
            </div>
          </section>
        </div>
      )}
      {deleteUser && (
        <div
          className="admin-modal-backdrop"
          onClick={() => setDeleteUser(null)}
        >
          <section
            className="admin-confirm-modal"
            role="dialog"
            aria-modal="true"
            onClick={(event) => event.stopPropagation()}
          >
            <h3>Xác nhận xóa tài khoản</h3>

            <p>
              Anh/chị có chắc chắn muốn xóa tài khoản{" "}
              <strong>
                {deleteUser.name || deleteUser.email || deleteUser.id}
              </strong>
              ?
            </p>

            <p className="admin-delete-warning">
              Thao tác này sẽ được thiết kế để xóa tài khoản. Hiện tại chưa có
              API thực hiện việc xóa.
            </p>

            <div className="admin-modal-actions">
              <button
                type="button"
                className="admin-modal-cancel"
                onClick={() => setDeleteUser(null)}
              >
                Hủy
              </button>
              <button
                type="button"
                className="admin-delete-confirm"
                onClick={() => setDeleteUser(null)}
              >
                Xác nhận
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
