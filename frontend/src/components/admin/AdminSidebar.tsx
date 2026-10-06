interface AdminSidebarProps {
  activeItem: string;
  onSelect: (item: string) => void;
}

const menuItems = [
  { id: "users", label: "Quản lý người dùng" },
  { id: "payments", label: "Quản lý thanh toán" },
];

export default function AdminSidebar({
  activeItem,
  onSelect,
}: AdminSidebarProps) {
  return (
    <aside className="admin-sidebar">
      <div className="admin-sidebar-title">QUẢN TRỊ</div>

      <nav>
        {menuItems.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`admin-sidebar-item ${
              activeItem === item.id ? "active" : ""
            }`}
            onClick={() => onSelect(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </aside>
  );
}