import type { ReactNode } from "react";
import AdminSidebar from "./AdminSidebar";
import "./Admin.css";

interface AdminLayoutProps {
  activeItem: string;
  onSelect: (item: string) => void;
  onBack: () => void;
  children: ReactNode;
}

export default function AdminLayout({
  activeItem,
  onSelect,
  onBack,
  children,
}: AdminLayoutProps) {
  return (
    <div className="admin-layout">
      <AdminSidebar activeItem={activeItem} onSelect={onSelect} />

      <div className="admin-main">
        <header className="admin-header">
          <button type="button" onClick={onBack}>
            <span aria-hidden="true">←</span>
            Quay lại
          </button>
        </header>

        <main className="admin-content">{children}</main>
      </div>
    </div>
  );
}
