# Đợt 3 — chuẩn bị iOS/Android, chưa phát hành

Trạng thái NOT_READY. Chỉ build và unit/mock trên Windows; không kết nối database, áp dụng migration, gọi Apple/Google thật hoặc thực hiện mua hàng.

## Quyết định đã được phê duyệt

- Chu kỳ bắt đầu/hết hạn mobile lấy từ cửa hàng sau xác minh, quota lấy từ Plan. Không dùng durationDays để giả lập tháng lịch.
- Một tài khoản chỉ có một gói trả phí còn hiệu lực, dùng chung Web/iOS/Android. Chặn mua mới trên mọi nền tảng khi còn gói trả phí; hết hạn được mua mới, không chuyển đổi hoặc cộng dồn quyền lợi.
- Gia hạn tự động chỉ cấp đúng một lần khi xác minh cùng chain, sản phẩm, Plan, môi trường và ranh giới chu kỳ của subscription đã được cấp. Thiếu bằng chứng hoặc có xung đột phải lưu cycle `REVIEW_REQUIRED`; không tự cấp lại khi replay. Giữ rollover gốc trong cửa sổ 24 giờ, mỗi source lot một lần; không rollover khi mua mới chéo nền tảng.
- Catalog vẫn luôn `purchaseEnabled=false` với lý do điều kiện phát hành chưa xác minh. Không có biến môi trường để bỏ qua gate. Có mã bridge mua hàng nhưng không mở charge trên app hiện tại.
- Chu kỳ đầu được chứng minh có thể ghi nhận/cấp quyền lợi khi restore/verify: một transaction dưới khóa User, ràng buộc account, product mapping, cycle key unique, liên kết subscription/quota. Không cấp lại quota cho cycle trùng. Google chỉ acknowledge sau commit GRANTED; Apple chỉ finish sau backend trả GRANTED và không cần review.

## Cấu hình backend chưa có giá trị mặc định

Chỉ đặt trong môi trường triển khai/kho bí mật; không commit credentials, token hoặc khóa riêng:

- `STORE_PRODUCT_MAPPING`: JSON array các object `platform` (`APPLE`/`GOOGLE`), `productId`, `planCode`; Google cần `basePlanId`. Không chứa giá. Map tới Plan có sẵn; không tự đăng ký sản phẩm hay chọn giá trên store.
- `STORE_REFERENCE_ENCRYPTION_KEY_BASE64`: khóa AES-256 ngẫu nhiên 32 byte, mã hóa reference/purchase token trước khi lưu. Phải có kế hoạch backup/rotation key riêng; không tự thay key sau khi có dữ liệu.
- Apple: `APPLE_STORE_ENVIRONMENT` (`Sandbox` hoặc `Production`), `APPLE_BUNDLE_ID`, `APPLE_APP_ID` (bắt buộc Production), `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY_BASE64`, `APPLE_ROOT_CA_DER_BASE64` (các public root DER từ Apple PKI, phân cách dấu phẩy). Không tin certificate do client tự cung cấp làm trust root. SDK bật kiểm tra certificate/OCSP, không fallback môi trường.
- Google: `GOOGLE_PLAY_ENVIRONMENT`, `GOOGLE_PLAY_PACKAGE_NAME`, `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`. Không fallback ADC, file credentials hoặc metadata-server. Service account cần quyền Google Play Publisher phù hợp cho subscriptions/Orders/acknowledge.
- RTDN: `GOOGLE_RTDN_AUDIENCE` là URL HTTPS chính xác và `GOOGLE_RTDN_SERVICE_ACCOUNT_EMAIL` là sender được cho phép. Pub/Sub push phải có OIDC; kiểm tra audience, issuer, email và email_verified rồi mới đọc trạng thái qua API Google.

Endpoint: GET `/store-billing/catalog`, POST `/store-billing/verify` yêu cầu JWT hiện hành. Apple notification POST `/store-billing/notifications/apple` xác minh JWS, Google POST `/store-billing/notifications/google` xác minh OIDC. Không có public API grant hoặc sửa owner. Restore đi qua cùng verifier/transaction; dữ liệu thiếu không cấp quyền lợi.

Apple dùng App Store Server API và SignedDataVerifier chính thức. Google dùng subscriptionsv2 và Orders metadata; không suy luận chu kỳ từ hậu tố order ID. Giá trị thời gian của Orders chỉ dùng đối chiếu nguồn gốc chu kỳ đầu, hạn quyền lợi lấy subscriptionsv2. Nhiều line item, token linked/replacement, offer/trial chưa được duyệt hoặc thiếu bằng chứng ban đầu phải review, không đoán.

Notification chỉ là tín hiệu để lấy trạng thái mới. So sánh observation, giữ revocation cuối cùng; không phục hồi receipt REVOKED tự động. Cancel auto-renew không cắt chu kỳ đã trả tiền; EXPIRED/ON_HOLD chỉ tác động subscription được liên kết; REVOKED thu hồi quota chưa dùng của chính cycle. Refund không đi kèm revocation được giữ review, không tự quyết định xử lý tiền hoặc quyền lợi khác. Không hoàn tiền qua API store trong đợt này.

## Schema/migration — CHƯA CHẠY

`20261106010000_add_store_verification_ledger`: StorePurchase/StoreCycle, token ciphertext, unique chain/cycle, FK User/Plan/Subscription, thêm Subscription.billingSource mặc định WEB. Không backfill receipt hoặc đổi giá/quota hiện có. FK RESTRICT giữ lịch sử; xóa tài khoản có store history cần quy trình riêng. Migration authVersion của đợt trước vẫn là điều kiện triển khai nếu chưa áp dụng.

Cron Web bỏ qua subscription mobile; Web payment không được thay thế gói mobile đang hoạt động. Cả hai cùng dùng khóa User với store/TTS. Không mở Payment Surplus Harness hoặc sửa guard của harness.

## Native và bảo mật

- Capacitor 8.6.0; iOS scaffold SPM được tạo trên Windows, chưa chứng minh build Xcode. Bundle/application identifier được giữ từ dự án hiện có, chủ dự án cần xác nhận quyền sở hữu trước upload.
- Android chặn cleartext/mixed content, không backup app data. iOS ATS chặn arbitrary HTTP. Production/native API bắt buộc HTTPS, không chấp nhận URL chứa userinfo/query/hash; cấu hình sai dừng, không fallback localhost/HTTP.
- Token native dùng Keychain/Keystore; iOS không iCloud sync, device-only. Token cũ trong Preferences bị xóa, không đọc/migrate; người dùng đăng nhập lại một lần. Web giữ storage hiện hữu, chưa chuyển sang HttpOnly cookie.
- Lỗi keychain không fallback plaintext. Logout chỉ báo thành công sau xóa token; dọn cache export best effort. Không lưu credentials IAP xuống file hay localStorage. Không bật debug bridge/logging trong cấu hình native.
- TTS/dialogue native dùng cùng CapacitorHttp cho iOS/Android; controls audio giữ nguyên. Xuất WAV từ blob nội bộ qua cache app + native Share sheet; Web download. Cache export không chứa token và được xóa best effort khi logout/OS cleanup. Android FileProvider chỉ cấp vùng cache export. Chưa kiểm chứng hành vi chia sẻ/phát trên thiết bị thật.
- Privacy manifest gồm reason cho UserDefaults/FileTimestamp theo plugin; không thay thế App Privacy/Data Safety và chính sách riêng tư do chủ dự án xác nhận.

## Các bước còn phải làm bên ngoài mã nguồn

1. Kiểm chứng chính sách một gói còn hiệu lực và gia hạn đúng một lần trên DB/sandbox sau phê duyệt riêng. Chuyển gói, free trial/offer, family sharing, refund và các cycle cần xét duyệt chưa được tự động xử lý; hoàn thiện quy trình đối soát trước khi mở purchase gate bằng đợt code được duyệt.
2. Apple Developer/App Store Connect và Google Play Console; bundle/package, paid agreement, tax/bank, sản phẩm/base plan, giá và thời hạn, sandbox tester, server keys và quyền service account. Không tự tạo/cấu hình tài khoản trong đợt này.
3. Cấu hình server endpoints HTTPS, OIDC Pub/Sub, Apple notifications, email/password-reset deep links hoặc universal links theo domain đã sở hữu; không tự đặt domain/association file cho domain chưa xác nhận.
4. Mac/Xcode: mở `frontend/ios/App/App.xcodeproj`, resolve SPM, xác nhận signing/team, In-App Purchase capability, privacy manifest, archive và TestFlight. Không được suy ra iOS PASS từ việc tạo scaffold.
5. Android: AAB build không đồng nghĩa đã có upload signing/Play App Signing; xác minh chứng thư, versionCode và internal testing. Không upload artifact debug.
6. Thiết bị/sandbox: purchase, pending, restore, đổi tài khoản, revoke/refund, mất mạng sau commit, foreground refresh, expiry/renewal, local token migration, HTTP 401, WAV playback/share; sau đó mới nghiệm thu ba nền tảng.

Dependencies có thư viện official Apple kéo `jsrsasign` với cảnh báo deprecated từ upstream; cần rà soát cập nhật/advisory trước phát hành, chưa kết luận có lỗ hổng từ cảnh báo này.

Không dùng mock PASS để xác nhận transaction store, certificate chain thực tế, PostgreSQL concurrency hoặc iOS runtime. Các hạn chế này giữ NOT_READY.
