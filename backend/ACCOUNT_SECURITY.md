# Cấu hình bảo mật tài khoản

Chưa sẵn sàng Production cho tới khi cấu hình và kiểm chứng các mục dưới đây.

## Email khôi phục

Cấp các biến qua môi trường triển khai/kho bí mật, không đưa giá trị thật vào Git:

- `SMTP_HOST`
- `SMTP_PORT`: 465 (TLS trực tiếp) hoặc 587 (STARTTLS bắt buộc).
- `SMTP_USER`, `SMTP_PASSWORD`
- `SMTP_FROM`: địa chỉ gửi được nhà cung cấp cho phép.
- `PASSWORD_RESET_FRONTEND_URL`: URL HTTPS chính xác của giao diện reset hiện có, không chứa query/hash/userinfo. Ứng dụng thêm tham số `token`.

Không có nhà cung cấp mặc định. Chưa gửi email thực tế. Lỗi gửi chỉ ghi mã `PASSWORD_RESET_MAIL_FAILED`, không trả token hoặc tiết lộ email có tồn tại. Không có hàng đợi/retry tự động; người dùng có thể yêu cầu lại trong giới hạn. SMTP chấp nhận email chưa chứng minh thư đã đến hộp thư.

## JWT và migration

Migration mới chỉ thêm `User.authVersion`, chưa được thực thi. Phải phê duyệt và áp dụng migration trước khi chạy backend mới; tái sinh Prisma Client khi build. JWT cũ thiếu phiên bản sẽ bị từ chối. Đổi/reset mật khẩu thu hồi mọi phiên, frontend yêu cầu đăng nhập lại. Không thay JWT_SECRET để thực hiện thu hồi.

## Giới hạn tần suất

Limiter chỉ áp dụng login/register/forgot-password, tính cả lần thành công và thất bại:

| Endpoint | Cửa sổ | Mỗi IP | Mỗi định danh trên mọi IP |
| --- | --- | --- | --- |
| login | 15 phút | 50 | 10 |
| register | 60 phút | 20 | 5 |
| forgot-password | 15 phút | 20 | 3 |

Đăng ký có cả email và phone sẽ tính cả hai định danh. Định danh được chuẩn hóa và HMAC bằng khóa ngẫu nhiên trong bộ nhớ, không log. Tối đa 10.000 bucket, dọn bucket hết hạn khi có request; hết dung lượng trả 429, không loại bucket còn hiệu lực. Không có timer giữ tiến trình sống.

Chỉ dùng địa chỉ socket, bỏ qua X-Forwarded-For để tránh giả IP. **Chưa chốt proxy/instance Production**: sau proxy, mọi người có thể cùng một IP socket; phải chốt proxy tin cậy hoặc limiter tại edge trước khi phát hành. Nhiều instance không chia sẻ bộ đếm; restart xóa bộ đếm. Chưa tuyên bố chống brute-force phân tán hoàn chỉnh. Không khóa tài khoản vĩnh viễn.

## Logging và vận hành

Không ghi body, token, nội dung TTS, URL chứa query hoặc raw SDK exception trong các đường đã sửa. Filter giữ HTTP status; mailer giữ mã lỗi cố định. Reverse proxy, nhà cung cấp email và hệ thống log ngoài ứng dụng cần cấu hình riêng để không lưu reset URL hay request body. Các log cũ không được công cụ này tự xóa.

Unit/mock không thay thế kiểm chứng email, migration, transaction cạnh tranh và thiết bị thực. Không chạy integration/SQL trong đợt này.
