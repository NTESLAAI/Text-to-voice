# ReceivingBankAccount — rollout cần phê duyệt riêng

Trạng thái: **NOT_READY**, **purchaseEnabled=false**. BANK01–BANK18 và hậu kiểm
READ ONLY đã PASS trên PostgreSQL tổng hợp độc lập, chưa áp dụng lên DB ứng dụng
hoặc Production trong bước này.

## Cấu hình mới (chỉ tên, không phải credentials)

- `RECEIVING_BANK_ACCOUNT_ID`: UUID tài khoản mặc định cho Payment mới.
- `SEPAY_RECEIVING_BANK_ACCOUNT_ID`: UUID tài khoản nhận webhook SePay.
- Giữ `BANK_TRANSFER_ACCOUNT_NUMBER`, `SEPAY_WEBHOOK_GATEWAY` để đối chiếu
  với danh mục. Không fallback từ metadata thiếu sang các biến cũ.
- Secret SePay giữ ở cấu hình secret hiện có, không lưu trong danh mục.

Payment trả hướng dẫn ngân hàng từ tài khoản đã gắn, không từ ENV thay đổi về sau.
MANUAL_ALLOWED không bị chặn chỉ vì một tài khoản khác sử dụng SePay.
Không dùng bankReference/referenceCode làm unique hoặc tự gộp xuyên provider.

## Trình tự triển khai cần phê duyệt riêng

1. Nghiệm thu cả ba migration và ứng dụng mới trên cluster tổng hợp mới.
2. Xác nhận backup/restore; khóa ingress ghi, gồm webhook, dừng TẤT CẢ backend,
   cron, worker và client vận hành có thể ghi. Kiểm tra session/transaction chưa rõ.
3. Không triển khai rolling. Cửa sổ bảo trì phải bao trùm cả ba migration.
4. Áp dụng `20261113000000_add_receiving_bank_account`, rồi
   `20261113010000_enforce_receiving_bank_policy`, cuối cùng
   `20261114000000_fix_bank_payment_guard_alias`. Migration dùng transaction,
   lock_timeout và statement_timeout hữu hạn; lỗi thì dừng, không retry/resolve.
   Migration 1 đã cài rollout fence chặn ghi receipt/kích hoạt/chi tiền dư;
   migration 2 chỉ gỡ fence sau khi có đủ guard cuối cùng, trong cùng transaction.
5. Kiểm tra enum, FK, index, trigger, checksum migration; đối chiếu số lượng và
   checksum trên các cột legacy (không so row JSON có thêm cột NULL).
   Không backfill, đổi status hoặc tính lại dữ liệu cũ.
6. Tạo danh mục thật bằng bước phê duyệt riêng. Bản ghi bắt đầu inactive;
   xác minh ngân hàng, số tài khoản giữ số 0 đầu, tên, policy và mapping SePay.
   Không có seed hoặc API public tạo/kích hoạt/đổi policy.
7. Phê duyệt kích hoạt từng tài khoản và cấu hình ID. Chỉ mở writer mới sau
   khi danh mục và cấu hình được kiểm chứng. Không tự mở purchaseEnabled.
8. Chốt việc gửi lại/đối soát webhook gián đoạn trước khi mở ingress;
   không giả định nhà cung cấp chắc chắn retry. Không ACK thành công giả.

Nếu bất kỳ migration nào lỗi, giữ bảo trì. Không mở ghi sau migration 2;
migration 3 sửa lỗi alias trong trigger và phải hoàn tất trước hậu kiểm. Không chạy app ở
trạng thái trung gian. Nếu rollback app, giữ luồng ghi ngân hàng đóng; không xóa
trigger/index/cột để app cũ tiếp tục ghi. Khôi phục DB cần phê duyệt riêng.
Writer ứng dụng không được là owner/superuser hoặc có quyền vô hiệu hóa trigger;
quyền thực tế phải kiểm tra trước triển khai, không thay đổi quyền trong đợt này.

## Bất biến và thứ tự khóa

- Tài khoản: FOR SHARE khi tiếp nhận hoặc hoàn tất receipt, FOR UPDATE khi inactive.
- Nhập thủ công: tài khoản -> advisory lock namespace BANK_TRANSFER + mã ->
  lookup legacy bằng câu lệnh mới trong READ COMMITTED -> lookup theo tài khoản -> INSERT.
- Gắn/xác minh/reconcile: tài khoản -> Payment -> receipt. Source/identity được
  kiểm tra lại dưới khóa. Advisory lock cấp transaction hoạt động giữa các process.
- Các partial unique index tách SEPAY/other, BANK_TRANSFER đã gắn tài khoản và
  BANK_TRANSFER legacy NULL. Index thay thế được tạo trước khi bỏ unique cũ.
- New INSERT thiếu tài khoản bị DB từ chối. Legacy không được thêm, sửa hoặc xóa.
- Receipt đã xác minh trước inactive được hoàn tất; receipt đến sau không được
  tự xác minh từ transactionDate. Không tự đổi policy hoặc re-activate.
- Audit MATCHED, identity receipt và identity tài khoản bất biến.
- SQL function/trigger chạy SECURITY INVOKER; không tạo SECURITY DEFINER.

## Số dư và tương thích

Tổng MATCHED, surplus, allocated và available vẫn dùng công thức Decimal cũ.
`spendabilityStatus=UNKNOWN`, `spendableAmount=null` nếu bất kỳ receipt MATCHED
không chứng minh được nguồn. Không coi UNKNOWN là 0, không âm thầm bỏ receipt.
Tạo/complete REFUND/CREDIT bị chặn; replay handling đã hoàn tất không tạo tác động;
cancel PENDING vẫn giải phóng reservation, giữ lịch sử. Subscription/Quota cũ không đổi.

Receipt thủ công mới cần receivingBankAccountId; proof và actor do backend xác
định từ JWT, không từ body. Confirm-received yêu cầu evidenceReference là mã
tham chiếu chứng từ nội bộ; đây là lời xác nhận có audit của Admin, không phải
xác minh tự động từ ngân hàng. Không gửi file sao kê hoặc bí mật trong trường này.
Yêu cầu evidenceReference áp dụng cho BANK_TRANSFER. Receipt SEPAY đã có proof
hợp lệ được link/confirm/reconcile mà không đổi sang MANUAL_ADMIN hoặc sửa thời
điểm xác minh, kể cả hoàn tất sau inactive. Thiếu proof thì tiếp tục bị chặn.
Admin chỉ xem tài khoản đã che số; endpoint danh mục
chỉ đọc có RBAC. Giao diện không xây thêm workflow CRUD/nhập receipt trong đợt này.

## Nghiệm thu PostgreSQL tổng hợp và điều kiện tái lập

BANK01–BANK18 và hậu kiểm reader đã được nghiệm thu trên cluster PG17 độc lập
ở cổng 61432, runId `029a35d4-5784-4b8e-9ab9-6ccd5e914be5`.
Đây là bằng chứng dữ liệu tổng hợp, không phê duyệt áp dụng DB ứng dụng.
Lần tái lập mới phải được duyệt cổng mới trống; không tái sử dụng hoặc sửa cluster
5432/55432/56432/57432/58432/59432/60432/61432 hoặc fixture cũ.
Credentials riêng trong vault được bảo vệ; không dotenv/PG*/DATABASE_URL app.
Writer và reader READ ONLY riêng; không mock transaction/unique/trigger/JWT.

Kịch bản bắt buộc: cold/upgrade legacy; NULL và partial index; ít nhất hai process
Node cạnh tranh cùng mã/cùng tài khoản, khác tài khoản và legacy collision;
old-writer INSERT/UPDATE/DELETE bị chặn; MANUAL_ALLOWED và SEPAY_PRIMARY;
giả proof/actor, account/currency mismatch; inactive cạnh tranh verification;
prior evidence hoàn tất sau inactive; webhook replay cạnh tranh reconcile;
direct-confirm không bypass; REFUND/CREDIT unknown nguồn bị chặn, cancel vẫn đạt;
rollback sau commit receipt và retry; audit/benefits chỉ một lần.
Quan sát pg_blocking_pids/pg_locks với thời gian hữu hạn, không chỉ Promise.all.
Reader đối chiếu dữ liệu legacy, balance, audit, quota và migration/index/trigger.
Giữ lại cluster/DB/artifact; không cleanup. Lỗi guard/identity thì dừng ngay.

Mock PASS không chứng minh SQL/trigger hoặc concurrency PostgreSQL thực tế PASS.

Xem `RELEASE_REVIEW.md` về generate/build cô lập, giới hạn runner lịch sử 26 migration
và điều kiện orchestration/vault trước khi tái lập nghiệm thu.
