# Quy tắc làm việc

- Trả lời bằng tiếng Việt, ngắn gọn, tiết kiệm token.
- Mỗi lần chỉ xử lý một thay đổi; đọc và phân tích các file liên quan trước khi sửa.
- Không sửa ngoài phạm vi yêu cầu hoặc ghi đè thay đổi hiện có của người dùng.
- Không sửa migration cũ; không hardcode giá hoặc quota.
- Không đọc hoặc tiết lộ bí mật trong `.env` và các biến thể của file này.
- Không commit `.env`, file audio hoặc file test tạm.
- Chỉ dùng DB test khi được người dùng cho phép; không tác động DB production.
- Sau khi sửa mã: chạy test → build → báo cáo diff. Với thay đổi chỉ tài liệu, kiểm tra diff và nêu rõ không chạy test/build.
- Không tự commit, push, reset Git hoặc deploy.
- Không thay đổi logic TTS nếu không liên quan đến yêu cầu.
- Hỏi người dùng trước mọi thao tác có nguy cơ mất dữ liệu.
- Trước khi sửa code, nêu các file dự kiến sửa và kế hoạch; chờ người dùng phê duyệt rồi mới sửa.
- Khi thay đổi schema, phải tạo migration mới.
- Không chạy seed, reset, migration hoặc script ghi DB khi chưa được người dùng cho phép.
- Nếu test/build lỗi ngoài phạm vi yêu cầu, báo cáo người dùng trước khi sửa lỗi đó.
