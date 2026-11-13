# Rà soát release — Giai đoạn 1

Trạng thái: **NOT_READY**, **purchaseEnabled=false**. Chưa chốt commit, tag hoặc artifact Production.

## Phạm vi và danh mục

Danh mục gồm 61 file: 15 source, 1 schema, 3 migration, 40 test/công cụ và 2 tài liệu. Bao gồm thay đổi các đợt trước; không coi tất cả là thay đổi mới. Release phải lấy toàn bộ checkout đã duyệt, không chỉ 61 file này.

| File | Nhóm |
|---|---|
| backend/prisma/schema.prisma | Schema |
| backend/src/admin/admin.controller.ts | Mã nguồn ứng dụng |
| backend/src/admin/admin.service.ts | Mã nguồn ứng dụng |
| backend/src/common/filters/http-exception.filter.ts | Mã nguồn ứng dụng |
| backend/src/payment-surplus/payment-surplus-write.spec.ts | Kiểm thử / công cụ nghiệm thu |
| backend/src/payment-surplus/payment-surplus.service.spec.ts | Kiểm thử / công cụ nghiệm thu |
| backend/src/payment-surplus/payment-surplus.service.ts | Mã nguồn ứng dụng |
| backend/src/payment/commerce-hardening.spec.ts | Kiểm thử / công cụ nghiệm thu |
| backend/src/payment/dto/create-bank-transaction.dto.ts | Mã nguồn ứng dụng |
| backend/src/payment/payment-transaction.service.spec.ts | Kiểm thử / công cụ nghiệm thu |
| backend/src/payment/payment-transaction.service.ts | Mã nguồn ứng dụng |
| backend/src/payment/payment.controller.spec.ts | Kiểm thử / công cụ nghiệm thu |
| backend/src/payment/payment.controller.ts | Mã nguồn ứng dụng |
| backend/src/payment/payment.service.spec.ts | Kiểm thử / công cụ nghiệm thu |
| backend/src/payment/payment.service.ts | Mã nguồn ứng dụng |
| backend/src/payment/sepay-hardening.spec.ts | Kiểm thử / công cụ nghiệm thu |
| backend/src/payment/sepay-webhook.service.spec.ts | Kiểm thử / công cụ nghiệm thu |
| backend/src/payment/sepay-webhook.service.ts | Mã nguồn ứng dụng |
| frontend/src/components/admin/AdminPayments.tsx | Mã nguồn ứng dụng |
| frontend/src/i18n/locales/en.ts | Mã nguồn ứng dụng |
| frontend/src/i18n/locales/vi.ts | Mã nguồn ứng dụng |
| frontend/src/services/api.ts | Mã nguồn ứng dụng |
| backend/RECEIVING_BANK_ROLLOUT.md | Tài liệu |
| backend/prisma/migrations/20261113000000_add_receiving_bank_account/migration.sql | Migration |
| backend/prisma/migrations/20261113010000_enforce_receiving_bank_policy/migration.sql | Migration |
| backend/prisma/migrations/20261114000000_fix_bank_payment_guard_alias/migration.sql | Migration |
| backend/src/common/filters/http-exception.filter.spec.ts | Kiểm thử / công cụ nghiệm thu |
| backend/src/payment/dto/verify-bank-receipt.dto.ts | Mã nguồn ứng dụng |
| backend/src/payment/receiving-bank-account.service.spec.ts | Kiểm thử / công cụ nghiệm thu |
| backend/src/payment/receiving-bank-account.service.ts | Mã nguồn ứng dụng |
| backend/src/payment/receiving-bank-flow.spec.ts | Kiểm thử / công cụ nghiệm thu |
| backend/test/jest-mocks/receiving-bank.fixture.ts | Kiểm thử / công cụ nghiệm thu |
| backend/test/rc17-acceptance/guard.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/rc17-acceptance/guard.mock.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/rc17-acceptance/integration.rc17.ts | Kiểm thử / công cụ nghiệm thu |
| backend/test/rc17-acceptance/jest.config.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/rc17-acceptance/prisma.config.ts | Kiểm thử / công cụ nghiệm thu |
| backend/test/rc17-acceptance/run.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/rc17-acceptance/setup.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/rc17-acceptance/worker.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/receiving-bank-acceptance/guard.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/receiving-bank-acceptance/guard.mock.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/receiving-bank-acceptance/integration.bank.ts | Kiểm thử / công cụ nghiệm thu |
| backend/test/receiving-bank-acceptance/jest.config.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/receiving-bank-acceptance/legacy.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/receiving-bank-acceptance/prisma.config.ts | Kiểm thử / công cụ nghiệm thu |
| backend/test/receiving-bank-acceptance/process-worker.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/receiving-bank-acceptance/run.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/receiving-bank-acceptance/setup.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/receiving-bank-acceptance/worker.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/refund-credit-acceptance/guard.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/refund-credit-acceptance/guard.mock.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/refund-credit-acceptance/integration.rc.ts | Kiểm thử / công cụ nghiệm thu |
| backend/test/refund-credit-acceptance/jest.config.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/refund-credit-acceptance/prisma.config.ts | Kiểm thử / công cụ nghiệm thu |
| backend/test/refund-credit-acceptance/run.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/refund-credit-acceptance/setup.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/test/refund-credit-acceptance/worker.cjs | Kiểm thử / công cụ nghiệm thu |
| frontend/test/bank-policy-admin.test.cjs | Kiểm thử / công cụ nghiệm thu |
| frontend/test/error-contract.test.cjs | Kiểm thử / công cụ nghiệm thu |
| backend/RELEASE_REVIEW.md | Tài liệu |

Không đưa `.env`, credentials, vault, dump, audio, dữ liệu cluster, log hoặc artifact runtime vào Git. Các template môi trường và lockfile đã tracked được giữ trong checkout; hướng dẫn này không đọc template hoặc môi trường thật.

## Hợp đồng lỗi

- Giữ HTTP status, `statusCode/message` và mọi success response hiện có.
- HTTP 400 chỉ bổ sung code `PAYMENT_UNDERFUNDED` khi khớp allowlist.
- HTTP 500 chỉ bổ sung `PAYMENT_ACTIVATION_FAILED`, `receiptStatus=MATCHED`, `activationStatus=FAILED` khi từng giá trị hợp lệ.
- Không spread exception response; 5xx dùng thông báo chung, không xuất raw exception, stack, detail hoặc credentials.
- Web/Mobile Axios giữ `error.response.status/data`; native binary TTS không thay đổi.
- Chưa xác minh trên thiết bị native hoặc môi trường Production.

## Generate Prisma Client không đọc môi trường thật

`backend/generated/prisma` và `backend/dist` là đầu ra build, không commit. Generator trong schema dùng `prisma-client`, output `../generated/prisma`, module CJS. Phải generate trước typecheck/build trên checkout sạch.

Không dùng `backend/prisma.config.ts` cho bước generate cô lập: file đó import dotenv. Cũng không dùng config nghiệm thu vì có identity guard kết nối DB.

Trong **bản sao build độc lập**, tạo config build tạm tại backend (kiểm tra chưa tồn tại trước khi tạo), nội dung UTF-8:

```ts
import { defineConfig } from 'prisma/config';
export default defineConfig({ schema: './prisma/schema.prisma' });
```

Gọi CLI local, cwd backend:

```powershell
node .\node_modules\prisma\build\index.js generate --config .\prisma.generate.build.config.ts
```

Chỉ generate; không migrate, db push, seed hoặc gọi acceptance config. Config tạm không vào Git/artifact. Tiến trình build dùng môi trường allowlist, không kế thừa DATABASE_URL, DIRECT_URL, SHADOW_DATABASE_URL, PG*, NODE_OPTIONS/NODE_PATH, npm credentials hoặc secrets runtime. Nếu dependency/generator thiếu hoặc yêu cầu mạng, dừng để phê duyệt, không fallback sang config ứng dụng.

## Quy trình build có thể tái lập

1. Sau phê duyệt commit, checkout SHA đầy đủ vào thư mục mới. Hiện chưa có commit release; bản sao working tree chỉ là snapshot kiểm tra, không gọi là clean checkout của release.
2. Ghi phiên bản Node/npm, OS/CPU, registry và checksum hai lockfile. Mốc kiểm tra hiện có: Node 22.23.2, npm 10.9.8. Không coi mốc này là chuẩn Production đã phê duyệt.
3. Trong backend/frontend chạy `npm.cmd ci --ignore-scripts` theo lockfile ở môi trường cô lập. Cần registry/cache được phê duyệt; kiểm tra install script bắt buộc của dependency trước khi cho chạy riêng. Không tự bật mọi lifecycle script hoặc cài lại từ package.json bằng npm install.
4. Generate Prisma Client theo config riêng ở trên. Xác minh output, không kết nối DB.
5. Chạy unit/mock đã chọn, không chạy Jest integration hoặc acceptance runner. Frontend dùng `node --test test/*.test.cjs`; backend chọn danh sách unit/mock rõ ràng với Jest config đã có.
6. Backend: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.build.json`, rồi `node node_modules/@nestjs/cli/bin/nest.js build`. Kiểm tra `dist/src/main.js` và `dist/generated/prisma/client.js`. Lệnh start đúng là `node dist/src/main.js`, nhưng không start trong bước build.
7. Frontend: `node node_modules/typescript/bin/tsc -b`. Build qua Vite API với `envDir:false` để không nạp env file, `mode:'release-check'`, và define `import.meta.env.VITE_API_BASE_URL` bằng HTTPS URL công khai đã duyệt. Kiểm tra local chỉ dùng `https://api.example.invalid`. Không dùng artifact synthetic làm Production.
8. Kiểm tra secrets trên source và đầu ra; không in nội dung tìm thấy. Chỉ public frontend config được phép nhúng vào JS.
9. Chạy lại trong thư mục sạch độc lập với cùng inputs và so checksum. Chưa khẳng định byte-identical nếu chưa chạy và đối chiếu.

Lệnh minh họa Vite API (cwd frontend, dependency local; không gọi dịch vụ):

```js
import { build } from 'vite';
await build({
  envDir: false,
  mode: 'release-check',
  define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('https://api.example.invalid') },
});
```

## Artifact và bằng chứng

- Gói source: toàn bộ commit đã duyệt cùng test/tài liệu; không kèm dữ liệu runtime.
- Backend runtime: dist và dependency Production tương thích OS/CPU đích; không copy node_modules Windows sang Linux. Schema/migration dành cho bước vận hành được phê duyệt riêng, không tự chạy khi giải nén hoặc khởi động.
- Web runtime: frontend/dist với public API URL đúng môi trường.
- Manifest build ghi SHA commit, checksum lockfile/schema/29 migration, Node/npm/OS/CPU, cấu hình công khai và SHA-256 artifact. Không ghi secrets.
- Native signing/archive và kiểm thử thiết bị là bước riêng, chưa được chứng minh bởi Web build.
- Chưa tạo artifact release chính thức trong giai đoạn tài liệu này.

## Giới hạn nghiệm thu PostgreSQL

`refund-credit-acceptance` và `rc17-acceptance` cố định 26 migration để bảo toàn bằng chứng lịch sử. Không dùng làm pipeline hiện hành 29 migration, không đổi số hoặc bỏ guard để ép PASS.
`receiving-bank-acceptance` kiểm tra đủ 29 migration và BANK01–18; không tự chạy khi deploy.

Tái lập PostgreSQL cần phê duyệt riêng: PG17 binary đúng phiên bản; endpoint/cổng mới trống được duyệt; runId/data directory mới; DB UUID, roles/owner/OID, cluster ID và marker xác minh; credentials mới trong vault bảo vệ; writer/reader riêng; dữ liệu tổng hợp; không kế thừa config ứng dụng. Chỉ chạy migration/test sau identity guard; lỗi phải dừng, không tự retry hoặc cleanup.

Orchestration provisioning/vault của các lần trước nằm ngoài repo. Chỉ có source test không đủ tái lập toàn bộ môi trường: cần quy trình orchestration đã rà soát, version/checksum công cụ và hợp đồng manifest/credential injection được phê duyệt. Không copy vault, mật khẩu hoặc dữ liệu cũ vào Git. Chưa chứng minh một-lệnh tái lập PostgreSQL từ checkout sạch.

## Secrets và trạng thái kiểm chứng

Quét heuristic 61 file không phát hiện mẫu private key, token phổ biến hoặc URL chứa credentials; sentinel trong test là dữ liệu tổng hợp. Không đọc .env; chưa kiểm toán toàn bộ lịch sử Git và không bảo đảm mọi loại secret đều được phát hiện.

Bằng chứng trước đợt tài liệu: Backend 275 unit/mock PASS; Frontend/Mobile 56 mock PASS; BANK01–18 và reader hậu kiểm PASS trên cluster riêng. Các kết quả mới của đợt này phải báo riêng, không thay thế bằng kết quả lịch sử.

Không stage/commit/push/tag/deploy; không migration, kết nối DB hoặc cleanup cluster. Chờ nghiệm thu trước bước chốt release.
