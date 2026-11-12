# Điều kiện vận hành thương mại — Đợt 2

Chỉ hoàn thành static/unit/mock; trạng thái vẫn NOT_READY. Không chạy SQL, migration, webhook ngân hàng hay AI thực tế trong đợt này.

## SePay

- Giữ HMAC-SHA256 trên `{timestamp}.{raw_body}`, kiểm tra thời gian ký trong 300 giây và so sánh constant-time, phù hợp tài liệu: https://developer.sepay.vn/en/sepay-webhooks/xac-thuc . Ngày giao dịch cũ không đồng nghĩa chữ ký hết hạn; retry cần timestamp ký còn hợp lệ.
- `BANK_TRANSFER_ACCOUNT_NUMBER` phải đúng tài khoản nhận đã công bố trên giao diện.
- Bổ sung `SEPAY_WEBHOOK_GATEWAY`: giá trị gateway chính xác do SePay gửi cho ngân hàng nhận. Thiếu cấu hình hoặc sai account/gateway đều chặn trước khi ghi nhận tiền. Không sửa file môi trường trong đợt này; cần kiểm chứng cấu hình ngoài mã trước triển khai.
- Luồng tự khớp chỉ dành cho VND. Payload không có currency được diễn giải là VND theo nghiệp vụ chuyển khoản ngân hàng hiện có; currency khác được giữ nguyên ở UNMATCHED, không gán theo currency của Payment.
- Nhiều mã đơn mâu thuẫn, đơn đã hủy/đã PAID hoặc không tìm thấy đơn đều cần đối soát thủ công. Không tự hoàn tiền.
- Thiếu tiền vẫn giữ MATCHED để cộng dồn. Đủ/thừa tiền đi qua transaction kích hoạt hiện có. Nếu kích hoạt lỗi, receipt đã commit vẫn được giữ và webhook trùng có thể thử kích hoạt lại; không tạo receipt thứ hai. Không nuốt lỗi unique nếu không tìm thấy duplicate thực sự.
- Chỉ bảo đảm idempotency theo `(provider, providerTransactionId)` hiện có. **Chưa thay đổi dữ liệu cũ hoặc khóa unique giữa BANK_TRANSFER và SEPAY**: cần quyết định cách nhận diện một giao dịch ngân hàng được nhập thủ công và đồng thời nhận webhook. Không được tuyên bố đã chống trùng xuyên provider.
- Không sửa cách tính tổng MATCHED cũ để tự sửa/backfill currency. Cần phê duyệt kiểm kê read-only trước khi quyết định xử lý các dòng lịch sử sai currency hoặc ghi nhận hai lần.

## Subscription và quota

- FREE hết hạn được phép mua paid bằng NEW_PURCHASE nếu lịch sử gần nhất vẫn là FREE; không khôi phục hạn hay quota FREE, không rollover FREE sang paid.
- Cron chỉ xử lý paid quá cửa sổ 24 giờ. Khóa User cùng thứ tự với TTS/activation trước khi đọc lại trạng thái, không cấp FREE nếu đã có subscription ACTIVE khác. FREE không được cron gia hạn lặp.
- Quota và duration được lấy từ Plan/snapshot, không hardcode các số thương mại trong service. Kỳ vọng của chủ dự án: FREE 5.000, BASIC 30.000, PRO 80.000, BUSINESS 250.000. **Chưa kiểm chứng các giá trị Plan trong database**, không seed/update để ép khớp.
- Giữ chính sách renewal sau hết hạn trong 24 giờ và rollover một lần hiện có. Không tự thay chính sách gia hạn trước hạn, downgrade, đơn trả tiền sau cửa sổ, hoặc credit/refund. Paid quá 24 giờ trước khi cron chạy vẫn cần xử lý theo chính sách hiện hữu, không tự nới cửa sổ.

## Giới hạn AI cho một backend instance

| Biến môi trường | Mặc định kỹ thuật |
| --- | --- |
| `AI_MAX_CONCURRENT` | 4 job trên toàn instance |
| `AI_USER_REQUESTS_PER_MINUTE` | 10 job/tài khoản/phút |
| `AI_DAILY_INPUT_CHARACTERS` | 1.000.000 ký tự đầu vào/UTC ngày |
| `AI_DAILY_PROVIDER_CALLS` | 1.000 lượt gọi/UTC ngày |
| `AI_REQUEST_TIMEOUT_MS` | 120.000 ms cho signal của job |
| `AI_REVIEW_MAX_OUTPUT_TOKENS` | 4.096 token |

Mỗi tài khoản tối đa một job, dùng chung giữa TTS/dialogue/text review, kể cả ADMIN. Đây là giới hạn kỹ thuật chống lạm dụng, không phải thay đổi characterLimit/quota của gói.

- Text review/speech tối đa 5.000 ký tự thô, dialogue tối đa 10.000 ký tự thô, 50 turn, mỗi turn tối đa 1.000. Không chỉ đếm chữ/số để giới hạn chi phí. Audio stream và tổng PCM dialogue có giới hạn bộ nhớ 64 MiB.
- Giữ nguyên model, preset, hướng dẫn đọc và định dạng. SDK nhận AbortSignal và tắt retry tự động. Job đang chạy chưa settle vẫn giữ slot; không dùng timeout Promise.race để giải phóng sớm rồi sinh thêm tác vụ nền.
- Ngân sách input/lượt gọi được giữ trước await, tính cả lần lỗi/hủy/không qua kiểm tra nghiệp vụ; không hoàn lại để tránh retry vượt ngân sách. Giới hạn số bucket tốc độ là 10.000, dọn theo TTL khi có request; hết bộ nhớ trả 429.
- Timer yêu cầu hủy AI; không cưỡng bức báo thất bại sau khi transaction lưu audio/quota đã commit. Nếu SDK/stream không tuân thủ hủy, slot vẫn bị giữ, cần kiểm chứng thực tế và giám sát tiến trình.
- Các bộ đếm ở RAM: restart xóa ngân sách, nhiều instance không chia sẻ. Không dùng cho nhiều instance trước khi chốt cơ chế giới hạn chung. Người dùng chưa hết quota vẫn có thể bị 429/503 khi hết hạn mức vận hành; cần chốt giá trị Production và thông báo hỗ trợ.
- **Đây không phải trần USD.** Số ký tự/lượt gọi không chứng minh số tiền thực tế, việc abort cũng không chứng minh nhà cung cấp ngừng tính phí. Cần chủ dự án đặt hạn mức thanh toán/API key phía nhà cung cấp và quyết định ngân sách USD trước phát hành; không tự ước tính đơn giá hoặc tạo ví/budget ledger.
- TTS tiếp tục ghi Usage sau khi tạo audio/quota transaction thành công; text review ghi AiUsage khi provider trả tổng cost hợp lệ. Thiếu cost thì báo `AI_USAGE_COST_UNKNOWN`, không ghi giả thành 0 USD. Chưa có số tiền thực tế của TTS stream, không tự tạo số liệu USD để tuyên bố đã đối soát chi phí. Text review chưa trừ quota theo gói, giữ chính sách hiện có; việc thay đổi chính sách này cần phê duyệt riêng.

## Admin

Trang thanh toán bổ sung tối đa 100 receipt UNMATCHED/RECEIVED gần nhất, tra cứu chính xác theo mã giao dịch ngân hàng (kể cả receipt cũ hơn) và thời điểm PAID. Các API liên kết/xác nhận nhận tiền/đối soát hiện có vẫn được giữ; không tự gọi các thao tác này từ trang báo cáo.

Schema hiện không liên kết trực tiếp Payment tới subscription được tạo. PAID/paidAt và snapshot không thay thế bằng chứng định danh subscription lịch sử. Không bổ sung migration/backfill liên kết tài chính khi chưa có phê duyệt riêng.

## Kiểm chứng tiếp theo cần phê duyệt riêng

Webhook SePay sandbox, transaction cạnh tranh PostgreSQL trên đúng TEST, kiểm kê Plan/currency/duplicate lịch sử, độ trễ/hủy stream thực tế, hạn mức nhà cung cấp và lựa chọn chính sách đã nêu. Không dùng mock PASS để kết luận đã nhận tiền thật hoặc đã sẵn sàng Production.
