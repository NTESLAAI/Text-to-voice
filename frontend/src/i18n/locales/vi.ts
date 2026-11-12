const vi = {
  translation: {
    auth: {
      login: {
        errors: {
          required: "Vui lòng nhập đầy đủ thông tin đăng nhập.",
          invalidRequest: "Thông tin đăng nhập chưa hợp lệ. Vui lòng kiểm tra lại.",
          invalidCredentials: "Email/số điện thoại hoặc mật khẩu không đúng. Vui lòng kiểm tra lại.",
          forbidden: "Yêu cầu đăng nhập bị từ chối. Vui lòng liên hệ hỗ trợ nếu cần.",
          rateLimited: "Bạn đã thử đăng nhập quá nhiều lần. Vui lòng thử lại sau.",
          serverError: "Hệ thống đang gặp lỗi. Vui lòng thử lại sau.",
          connectionError: "Không thể kết nối đến máy chủ. Vui lòng kiểm tra kết nối mạng.",
          timeout: "Yêu cầu đăng nhập đã hết thời gian chờ. Vui lòng thử lại.",
          sessionStorage: "Không thể lưu phiên đăng nhập trên thiết bị. Vui lòng thử lại.",
          unexpected: "Không thể hoàn tất đăng nhập. Vui lòng thử lại.",
        },
      },
    },
    // Store prices come from native product metadata, never Plan.price.
    mobile: { externallyManaged: "Gói này do cửa hàng ứng dụng quản lý. Vui lòng quản lý trong ứng dụng, không chuyển khoản cho gói chồng lấn.", billing: 'Gói trên cửa hàng ứng dụng', policyPending: 'Mua mới đang tạm khóa trong khi hoàn thiện chính sách gia hạn và mua nhiều nền tảng.', notConfigured: 'Chưa có sản phẩm hoặc giá đã được cửa hàng xác nhận.', buy: 'Đăng ký', restore: 'Khôi phục giao dịch', manage: 'Quản lý / hủy subscription', verified: 'Đã gửi yêu cầu xác minh. Quyền sử dụng lấy từ backend; giao dịch có thể cần xét duyệt.', failed: 'Không thể hoàn tất. Hãy kiểm tra kết nối, phiên đăng nhập hoặc liên hệ hỗ trợ.', exportAudio: 'Tải / lưu âm thanh' },
    app: {
      title: "Text to Voice",
      subtitle: "CHUYỂN CHỮ THÀNH GIỌNG NÓI",
    },

    language: {
      label: "Ngôn ngữ",
      vietnamese: "Tiếng Việt",
      english: "English",
    },

    tts: {
      title: "TEX-TO-VOICE",
      placeholder: "Nhập văn bản cần đọc...",
      generate: "Tạo giọng nói",
      generating: "Đang tạo giọng nói...",
      characters: "{{count}} / 5000 ký tự",
      history: "Lịch sử âm thanh",
      play: "Phát",
      delete: "Xóa",
      duration: "{{duration}} giây",
      empty: "Chưa có âm thanh nào.",
      confirmDelete: "Bạn có chắc muốn xóa âm thanh này?",
    },

    common: {
      error: "Đã xảy ra lỗi.",
      loading: "Đang tải...",
      confirmLogout: "Bạn có muốn đăng xuất không?",
      yes: "Đồng ý",
      cancel: "Huỷ",
    },
  },
};

export default vi;
