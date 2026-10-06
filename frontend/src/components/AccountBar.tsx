import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import {
  clearAuth,
  getAuthUser,
  type StoredUser,
} from "../services/authStorage";

interface AccountBarProps {
  onLogout: () => void;
  onAccount: () => void;
  onAdmin: () => void;
}

function AccountBar({ onLogout, onAccount, onAdmin }: AccountBarProps) {
  const { t } = useTranslation();
  const [user, setUser] = useState<StoredUser | null>(null);
  const [open, setOpen] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getAuthUser().then(setUser);
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (
        accountRef.current &&
        !accountRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }

    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [open]);

  async function handleLogout() {
    await clearAuth();
    setShowLogoutConfirm(false);
    setOpen(false);
    onLogout();
  }

  const displayName = user?.name || user?.email || "Tài khoản";

  const initials =
    user?.name
      ?.trim()
      .split(/\s+/)
      .slice(-2)
      .map((part) => part.charAt(0).toUpperCase())
      .join("") ||
    user?.email?.charAt(0).toUpperCase() ||
    "U";

  return (
    <div
      ref={accountRef}
      style={{
        position: "relative",
        width: "100%",
      }}
    >
      {/* Account button */}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "8px 10px",
          border: "none",
          borderRadius: "10px",
          background: open ? "#e9e9e9" : "transparent",
          color: "#2f2f2f",
          cursor: "pointer",
          textAlign: "left",
          transition: "background 0.15s ease",
        }}
        onMouseEnter={(event) => {
          if (!open) {
            event.currentTarget.style.background = "#ececec";
          }
        }}
        onMouseLeave={(event) => {
          if (!open) {
            event.currentTarget.style.background = "transparent";
          }
        }}
      >
        {/* Avatar */}
        <span
          style={{
            width: "32px",
            height: "32px",
            minWidth: "32px",
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#d9d9d9",
            color: "#444",
            fontSize: "13px",
            fontWeight: 600,
          }}
        >
          {initials}
        </span>

        {/* Name */}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: "14px",
            fontWeight: 500,
          }}
        >
          {displayName}
        </span>

        {/* More icon */}
        <span
          style={{
            fontSize: "18px",
            lineHeight: 1,
            color: "#777",
            paddingBottom: "3px",
          }}
        >
          ⋯
        </span>
      </button>

      {/* Account menu */}
      {open && (
        <div
          className="ttv-account-menu"
          style={{
            position: "absolute",
            left: "0",
            bottom: "calc(100% + 8px)",
            width: "220px",
            padding: "6px",
            border: "1px solid #e5e5e5",
            borderRadius: "10px",
            background: "#ffffff",
            boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",
            zIndex: 1000,
          }}
        >
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onAccount();
            }}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "10px 12px",
              border: "none",
              borderRadius: "7px",
              background: "transparent",
              color: "#2f2f2f",
              fontSize: "14px",
              cursor: "pointer",
              textAlign: "left",
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = "#f1f1f1";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = "transparent";
            }}
          >
            <span>👤</span>
            <span>Tài khoản</span>
          </button>
          {user?.role === "ADMIN" && (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onAdmin();
              }}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: "10px 12px",
                border: "none",
                borderRadius: "7px",
                background: "transparent",
                color: "#2f2f2f",
                fontSize: "14px",
                cursor: "pointer",
                textAlign: "left",
              }}
              onMouseEnter={(event) => {
                event.currentTarget.style.background = "#f1f1f1";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.background = "transparent";
              }}
            >
              <span>⚙️</span>
              <span>Quản trị</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setShowLogoutConfirm(true);
            }}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: "10px",
              padding: "10px 12px",
              border: "none",
              borderRadius: "7px",
              background: "transparent",
              color: "#2f2f2f",
              fontSize: "14px",
              cursor: "pointer",
              textAlign: "left",
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = "#f1f1f1";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = "transparent";
            }}
          >
            <span>↪</span>
            <span>Đăng xuất</span>
          </button>
        </div>
      )}

      {/* Logout confirmation */}
      {showLogoutConfirm && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0, 0, 0, 0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "16px",
            zIndex: 2000,
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="logout-confirm-title"
            style={{
              width: "100%",
              maxWidth: "360px",
              padding: "24px",
              borderRadius: "12px",
              background: "#fff",
              boxShadow: "0 8px 30px rgba(0, 0, 0, 0.2)",
              textAlign: "center",
            }}
          >
            <p
              id="logout-confirm-title"
              style={{
                margin: "0 0 22px",
                fontSize: "16px",
                color: "#2f2f2f",
              }}
            >
              {t("common.confirmLogout")}
            </p>

            <div
              style={{
                display: "flex",
                justifyContent: "center",
                gap: "12px",
              }}
            >
              <button
                type="button"
                onClick={() => setShowLogoutConfirm(false)}
                style={{
                  padding: "9px 18px",
                  border: "1px solid #ccc",
                  borderRadius: "7px",
                  background: "#fff",
                  color: "#333",
                  cursor: "pointer",
                }}
              >
                {t("common.cancel")}
              </button>

              <button
                type="button"
                onClick={handleLogout}
                style={{
                  padding: "9px 18px",
                  border: "none",
                  borderRadius: "7px",
                  background: "#2563eb",
                  color: "#fff",
                  cursor: "pointer",
                }}
              >
                {t("common.yes")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AccountBar;
