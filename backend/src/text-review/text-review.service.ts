import { Injectable } from '@nestjs/common';
import { OpenRouter } from '@openrouter/sdk';

export interface TextReviewResult {
    hasErrors: boolean;
    errors: string[];
    suggestion: string;
    correctedText: string;
}

@Injectable()
export class TextReviewService {
    private readonly client: OpenRouter;

    constructor() {
        const apiKey=process.env.OPENROUTER_API_KEY;

        if (!apiKey) {
            throw new Error('OPENROUTER_API_KEY is not configured');
        }

        this.client=new OpenRouter({
            apiKey,
        });
    }

    async reviewText(
        text: string,
    ): Promise<TextReviewResult> {
        const response=await this.client.chat.send({
            chatRequest: {
                model: 'openai/gpt-5.2',
                messages: [
                    {
                        role: 'system',
                        content:
                            'Bạn là trợ lý chuyên kiểm tra và sửa văn bản tiếng Việt. '+
                            'Bạn phải trả về DUY NHẤT một JSON hợp lệ, không markdown, '+
                            'không giải thích bên ngoài JSON. '+
                            'Không được thay đổi ý nghĩa của người dùng.',
                    },
                    {
                        role: 'user',
                        content: `
Hãy kiểm tra văn bản sau.

Yêu cầu:
1. Phát hiện lỗi chính tả.
2. Phát hiện lỗi dấu câu.
3. Phát hiện cách diễn đạt chưa tự nhiên nếu có.
4. Không tự ý thay đổi nội dung hoặc ý nghĩa.
5. Tạo một bản correctedText đã sửa hoàn chỉnh.
6. correctedText là VĂN BẢN CUỐI CÙNG sẽ được ứng dụng đưa trực tiếp vào ô nhập văn bản và dùng để đọc TTS.
7. correctedText chỉ được chứa nội dung văn bản sau khi sửa.
8. TUYỆT ĐỐI KHÔNG đặt toàn bộ correctedText trong dấu ngoặc kép, dấu nháy đơn, markdown hoặc bất kỳ ký hiệu nào chỉ dùng để trích dẫn hay minh họa.
9. Không thêm dấu ngoặc kép ở đầu và cuối correctedText chỉ để đánh dấu hoặc trích dẫn câu được đề xuất.
10. Nếu dấu ngoặc kép nằm bên trong nội dung và là một phần hợp lệ của văn bản thì phải giữ nguyên.
11. suggestion là phần giải thích dành cho người dùng, nên có thể dùng dấu ngoặc kép để trích dẫn hoặc minh họa câu đề xuất.
12. suggestion và correctedText có mục đích khác nhau: suggestion dành cho người đọc, correctedText dành cho ứng dụng sử dụng trực tiếp.
13. Nếu không có lỗi, hasErrors phải là false, errors phải là [] và correctedText phải giữ nguyên chính xác văn bản gốc.

Phải trả về đúng cấu trúc JSON sau:

{
  "hasErrors": true,
  "errors": [
    "mô tả lỗi 1",
    "mô tả lỗi 2"
  ],
  "suggestion": "gợi ý diễn đạt nếu có, nếu không thì để chuỗi rỗng",
  "correctedText": "Chỉ văn bản sau khi sửa, không bao quanh toàn bộ văn bản bằng dấu ngoặc kép"
}

Văn bản cần kiểm tra:
"${text}"
          `,
                    },
                ],
            },
        });

        const result=response as {
            choices?: Array<{
                message?: {
                    content?: string|null;
                };
            }>;
        };

        const content=
            result.choices?.[0]?.message?.content?.trim()??'';

        try {
            const parsed=
                JSON.parse(content) as TextReviewResult;

            const rawCorrectedText=
                typeof parsed.correctedText==='string'
                    ? parsed.correctedText.trim()
                    :text;

            const originalText=text.trim();

            const correctedText=
                rawCorrectedText.length>=2&&
                    rawCorrectedText.startsWith('"')&&
                    rawCorrectedText.endsWith('"')&&
                    !originalText.startsWith('"')&&
                    !originalText.endsWith('"')
                    ? rawCorrectedText.slice(1, -1).trim()
                    :rawCorrectedText;

            return {
                hasErrors: Boolean(parsed.hasErrors),
                errors: Array.isArray(parsed.errors)
                    ? parsed.errors
                    :[],
                suggestion:
                    typeof parsed.suggestion==='string'
                        ? parsed.suggestion
                        :'',
                correctedText,
            };
        } catch {
            return {
                hasErrors: true,
                errors: [
                    'AI trả về kết quả không đúng định dạng.',
                ],
                suggestion: '',
                correctedText: text,
            };
        }
    }
}