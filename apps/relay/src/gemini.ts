import type { VisionModel } from '@web2figma/image-pipeline';

/**
 * Creates a VisionModel function powered by Google Gemini API (free tier).
 * Uses high-quality Gemini 3.5 Flash with fallback to 3.1 Flash-Lite and Flash-Latest.
 */
export function createGeminiVisionModel(apiKey: string): VisionModel {
  return async ({ system, prompt, image, renderedImage }) => {
    const parseDataUrl = (dataUrl: string): { mimeType: string; data: string } => {
      const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        const comma = dataUrl.indexOf(',');
        return {
          mimeType: 'image/png',
          data: comma !== -1 ? dataUrl.slice(comma + 1) : dataUrl,
        };
      }
      return { mimeType: match[1] || 'image/png', data: match[2] || '' };
    };

    const mainImage = parseDataUrl(image);
    const parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [
      {
        inlineData: {
          mimeType: mainImage.mimeType,
          data: mainImage.data,
        },
      },
    ];

    if (renderedImage) {
      const ren = parseDataUrl(renderedImage);
      parts.push({
        inlineData: {
          mimeType: ren.mimeType,
          data: ren.data,
        },
      });
    }

    parts.push({ text: prompt });

    const callModel = async (modelName: string): Promise<string> => {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: system }],
          },
          contents: [
            {
              parts,
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 8192,
          },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`${modelName} error (${res.status}): ${errText}`);
      }

      const data = (await res.json()) as {
        candidates?: Array<{
          content?: {
            parts?: Array<{ text?: string }>;
          };
        }>;
      };

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error(`${modelName} returned an empty response`);
      }
      return text;
    };

    const candidateModels = [
      'gemini-3.6-flash',
      'gemini-3.1-flash-lite',
      'gemini-flash-lite-latest',
      'gemini-3.5-flash-lite',
      'gemini-flash-latest',
    ];
    let lastError: Error | null = null;

    for (const m of candidateModels) {
      try {
        return await callModel(m);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`Model ${m} failed, trying next candidate...`, lastError.message);
      }
    }

    throw lastError ?? new Error('All Gemini model candidates failed');
  };
}
