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
6. Nếu không có lỗi, hasErrors phải là false.
7. Nếu không có lỗi, errors phải là [] và correctedText phải giữ nguyên văn bản.

Phải trả về đúng cấu trúc JSON sau:

{
  "hasErrors": true,
  "errors": [
    "mô tả lỗi 1",
    "mô tả lỗi 2"
  ],
  "suggestion": "gợi ý diễn đạt nếu có, nếu không thì để chuỗi rỗng",
  "correctedText": "văn bản đã sửa"
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

            return {
                hasErrors:Boolean(parsed.hasErrors),
                errors:Array.isArray(parsed.errors)
                    ? parsed.errors
                    :[],
                suggestion:
                    typeof parsed.suggestion==='string'
                        ? parsed.suggestion
                        :'',
                correctedText:
                    typeof parsed.correctedText==='string'
                        ? parsed.correctedText
                        :text,
            };
        } catch {
            return {
                hasErrors:true,
                errors:[
                    'AI trả về kết quả không đúng định dạng.',
                ],
                suggestion:'',
                correctedText:text,
            };
        }
    }
}