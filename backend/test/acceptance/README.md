# Công cụ nghiệm thu — NOT_READY

Ở Đợt 4B chưa tạo cluster, role, database hoặc chạy migration/integration/backup/restore.
`purchaseEnabled=false` trong mã nghiệp vụ được giữ nguyên. Các mock không chứng minh PostgreSQL,
SMTP, Apple/Google, SePay hoặc thiết bị hoạt động thực tế.

Đợt 4C đã xác minh cluster riêng `a2fa1cce-2c02-4d83-a8a9-e373bd50da84`,
system identifier `7705385611083166840`, endpoint `127.0.0.1:56432`.
Cold 26 migration, upgrade 24 → 26, 14 integration cases và backup/restore tổng hợp đều PASS.
Không chạy lại migration khi sửa lỗi khởi chạy test. Credentials của riêng cluster này nằm
trong vault Windows DPAPI CurrentUser/ACL hạn chế ngoài Git; không chứa credentials DEV/TEST.
Cluster, dữ liệu tổng hợp và artifacts vẫn được giữ lại; không tự cleanup.

Hai lỗi khởi chạy đã sửa: Jest tự dò nhiều config khi cwd khác project; Nest JWT/Passport
ESM chưa được chuyển đổi. Worker hiện ghim trực tiếp đường dẫn config nghiệm thu, chuyển đổi
gói ESM thật (không mock JWT/Passport), dùng audio workspace riêng cho từng attempt và giữ
mã diagnostic cố định khi chưa thu thập được kết quả. Các guard identity không bị nới lỏng.

## Phạm vi và thứ tự Đợt 4C — chỉ sau phê duyệt riêng

1. Xác minh binary PostgreSQL 17; cổng `127.0.0.1:56432` trống. Tạo cluster mới bằng
   quy trình được phê duyệt, directory `D:/text-to-voice-it/<runId>/pgdata`.
   Không dùng 5432/55432, không sửa dịch vụ/HBA/data directory hiện hữu.
2. Cấp ba role mới theo tên `ttv_it_owner_<8 ký tự đầu runId>`, `ttv_it_writer_...`,
   `ttv_it_reader_...`. Cả ba phải NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOREPLICATION/NOBYPASSRLS.
   Owner sở hữu ba database; writer không sở hữu database hay bảng; reader không có quyền ghi.
   Chỉ bootstrap do người vận hành quản lý được phép provisioning, không dùng trong tests.
3. Provision ba database có tên `ttv_it_cold_<runId bỏ dấu ->`, `ttv_it_upgrade_...`,
   `ttv_it_restored_...`. Ban đầu đều trống. Cấp CONNECT và quyền nhận diện cluster cần thiết
   trong CHÍNH cluster mới: EXECUTE `pg_control_system()` và quyền đọc `data_directory`
   (ví dụ `pg_read_all_settings` hiệu lực). Công cụ không tự cấp quyền hoặc bỏ guard.
   Writer cần đọc/ghi bảng ứng dụng sau migration, owner cần CREATE schema objects,
   reader cần SELECT bảng ứng dụng và migration history; cấu hình default privileges/ACL
   trên cluster mới phải được phê duyệt riêng. Reader không được có ownership, SET tới owner,
   quyền ghi relation/column/sequence hoặc CREATE trên public. TEMP qua PUBLIC không được
   coi là quyền đọc tuyệt đối; các truy vấn hậu kiểm vẫn bọc transaction READ ONLY.
4. Ghi nhận cluster ID MỚI, role/database OID, owner OID; đặt comment marker ngẫu nhiên riêng
   cho mỗi database và ghi SHA-256 vào manifest. Không sao chép marker/credentials cũ.
   Manifest chỉ chứa metadata, không chứa URL/password. Không ghi marker token vào báo cáo.
5. Chốt checksum mã/migrations và kiểm tra lại static/mock. Chỉ sau đó cho chạy từng action
   riêng bên dưới. Nếu FAIL/UNKNOWN: dừng, không retry, không suy đoán rollback/cleanup.

## Manifest do provisioning được phê duyệt cung cấp

File ngoài Git, ví dụ `D:/text-to-voice-it/<runId>/manifest.json`:

```text
version: 1
runId: UUID v4 chữ thường, duy nhất
clusterId: chuỗi số nguyên 64-bit của cluster mới (không dùng cluster 55432)
dataDirectory: D:/text-to-voice-it/<runId>/pgdata
roles:
  owner/writer/reader: { name: tên role được ghim, oid: chuỗi OID }
databases:
  cold/upgrade/restored:
    { name: tên database được ghim, oid: chuỗi OID,
      ownerOid: OID role owner, markerSha256: 64 hex chữ thường }
```

Mọi khóa thừa/thiếu, OID sai, URL không chính xác hoặc approval sai đều bị từ chối.
Không dùng file mẫu có OID/cluster ID giả để chạy thật. Đây không phải bằng chứng nguồn gốc
độc lập: người vận hành phải đối chiếu manifest với provisioning của chính lần chạy.

## Lệnh dự kiến — KHÔNG thực hiện trong Đợt 4B

Trong `D:\text-to-voice\backend`, sau khi được phê duyệt tạo môi trường và migration:

```powershell
.\test\acceptance\invoke.ps1 -ManifestPath 'D:\text-to-voice-it\<runId>\manifest.json' -Action migrate-cold
.\test\acceptance\invoke.ps1 -ManifestPath 'D:\text-to-voice-it\<runId>\manifest.json' -Action upgrade-base
.\test\acceptance\invoke.ps1 -ManifestPath 'D:\text-to-voice-it\<runId>\manifest.json' -Action upgrade-final
.\test\acceptance\invoke.ps1 -ManifestPath 'D:\text-to-voice-it\<runId>\manifest.json' -Action test
.\test\acceptance\invoke.ps1 -ManifestPath 'D:\text-to-voice-it\<runId>\manifest.json' -Action backup-restore
```

`<runId>` phải được thay bằng định danh đã provisioning. Mỗi action yêu cầu gõ lại
`APPROVE <runId> <action>` và nhập ba URL mới tại prompt ẩn. Không nhập credentials qua chat.
URL maintenance phải chính xác `postgresql://<role>:<password đã URL-encode>@127.0.0.1:56432/postgres`.
Tool chỉ suy ra đích UUID từ manifest, không kết nối database postgres để chạy nghiệp vụ.
Không URL/password trên command line hoặc file tạm; chỉ qua stdin/pipe. PowerShell xóa biến
trong finally; managed strings không có bảo đảm xóa vật lý khỏi RAM. Child backup dùng
PGPASSWORD tạm thời từ prompt mới, không kế thừa PG* hay credentials ứng dụng.

Không thay Execution Policy tự động. Phiên shell có DATABASE_URL/DIRECT_URL/PG*/NODE_OPTIONS
bị từ chối; dùng shell sạch thay vì nạp .env. Không gọi Jest/Prisma config này trực tiếp.

## Những kiểm tra đã chuẩn bị

- Migration: 26 migration cold; upgrade 24 → 26 với User/Plan/Subscription tổng hợp;
  đối chiếu tên, SHA-256, finished/rolled_back và default authVersion/billingSource.
- 14 ca A01–A13 (A08 cho cả Apple và Google): đăng ký nguyên tử, JWT thật/401/thu hồi phiên,
  reset cạnh tranh, HTTP SePay HMAC thật/thiếu–thừa tiền/replay, TTS tranh quota, cron với
  activation, ledger/renewal/notification cạnh tranh, mua chéo, rollback lỗi CHECK thật,
  AI thất bại không tiêu quota. Chỉ provider AI, mail và xác minh cửa hàng dùng dữ liệu giả.
  Lỗi CHECK trong database mới còn kiểm chứng rollback ledger/quota trước acknowledge và
  rollback token/authVersion khi cập nhật mật khẩu thất bại; không mock Prisma để gây lỗi.
- Các test cạnh tranh giữ khóa row bằng PG connection độc lập, quan sát metadata chờ khóa
  bằng `pg_blocking_pids`/`pg_stat_activity`; thiếu quyền hoặc không thấy cạnh tranh là FAIL.
  Không lấy query text. Không mock transaction, Prisma, khóa hay JWT.
- Backup: pg_dump/pg_restore 17 trên hai DB cùng run, không --create/--clean; đích phải trống,
  identity kiểm lại, so sánh count/digest dữ liệu tổng hợp bằng reader READ ONLY.
- Audio chỉ ghi vào thư mục run riêng. Không ScheduleModule tự chạy cron; chỉ gọi cron rõ ràng.
  Không import AppModule, không dùng e2e config cũ hoặc Harness Payment Surplus.

## Giới hạn còn lại

- Chưa chứng minh SQL/catalog/CLI config/locking thực thi thành công. Cluster chưa tồn tại;
  role ACL, binary backup, cổng và đường dẫn chưa được kiểm chứng thực tế.
- Snapshot/digest backup yêu cầu môi trường độc quyền, không writer đồng thời. Không phải
  thiết kế backup Production hoặc chứng minh phục hồi audio/key mã hóa. Giữ artifacts khi lỗi.
- Timeout child trả UNKNOWN, không bảo đảm child/grandchild hoặc DB operation đã dừng;
  không tự cleanup, retry hay phát lệnh quản trị tiếp. Cần kiểm tra trạng thái sau phê duyệt.
- Guard giảm rủi ro nhầm đích; không chống quản trị viên cố ý thay server/directory giữa guard
  và thao tác. Cần vận hành độc quyền, không DDL/quản trị đồng thời.
- Đây là bộ tối thiểu kiểm tra lõi backend, không chứng minh đủ 11 yêu cầu thương mại trên
  thiết bị: vẫn cần UI, iOS/Xcode/signing, Android, SMTP delivery, SePay thực, sandbox store,
  webhook/JWS/OIDC thật, legal/support và nghiệm thu backup Production riêng.
- Không xóa database, role, thư mục, archive hoặc dữ liệu cũ. Việc đóng cluster mới và xử lý
  artifacts cần phê duyệt riêng. Không tác động database tồn dư OID 16393.

Static/mock an toàn: `node --test test/acceptance/guard.mock.cjs` và
`powershell -NoProfile -File test/acceptance/wrapper.mock.ps1`.
Không chạy `npm test` rộng hoặc file `integration.acceptance.ts` trong Đợt 4B.
Nếu Execution Policy chặn mock PowerShell, giữ nguyên policy: chỉ ghi nhận syntax bằng parser,
không coi mock wrapper là PASS và không tự dùng Bypass/Unrestricted.
