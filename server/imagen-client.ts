import fs from "fs";
import path from "path";
import { log } from "./index";

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY не настроен");
  return key;
}

export async function generateImage(
  prompt: string,
  options: {
    model?: string;
    aspectRatio?: string;
    referenceImageBase64?: string;
    referenceImageMimeType?: string;
  } = {}
): Promise<{ base64: string; mimeType: string }> {
  const apiKey = getApiKey();
  const model = options.model || "imagen-4.0-generate-001";
  const aspectRatio = options.aspectRatio || "9:16";

  log(`[imagen] Generating image (${model}): "${prompt.substring(0, 80)}..."`, "imagen");

  const requestBody: Record<string, any> = {
    instances: [{ prompt }],
    parameters: {
      sampleCount: 1,
      aspectRatio,
    },
  };

  if (options.referenceImageBase64) {
    requestBody.instances[0].referenceImages = [{
      referenceImage: {
        bytesBase64Encoded: options.referenceImageBase64,
        mimeType: options.referenceImageMimeType || "image/png",
      },
      referenceType: "STYLE_REFERENCE",
    }];
  }

  const resp = await fetch(
    `${GEMINI_API_URL}/models/${model}:predict?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    log(`[imagen] Error (${resp.status}): ${text.substring(0, 300)}`, "imagen");
    throw new Error(`Imagen API error (${resp.status}): ${text.substring(0, 300)}`);
  }

  const data = await resp.json();

  const prediction = data.predictions?.[0];
  if (!prediction?.bytesBase64Encoded) {
    throw new Error("Imagen: no image in response: " + JSON.stringify(data).substring(0, 300));
  }

  log(`[imagen] Image generated successfully`, "imagen");
  return {
    base64: prediction.bytesBase64Encoded,
    mimeType: prediction.mimeType || "image/png",
  };
}

export async function generateImageWithGemini(
  prompt: string,
  options: {
    model?: string;
    referenceImageBase64?: string;
    referenceImageMimeType?: string;
  } = {}
): Promise<{ base64: string; mimeType: string }> {
  const apiKey = getApiKey();
  const model = options.model || "gemini-2.5-flash-image";

  log(`[imagen] Generating image via Gemini (${model}): "${prompt.substring(0, 80)}..."`, "imagen");

  const parts: any[] = [];

  if (options.referenceImageBase64) {
    parts.push({
      inlineData: {
        data: options.referenceImageBase64,
        mimeType: options.referenceImageMimeType || "image/png",
      },
    });
    parts.push({ text: `Using this reference image as a style guide. ${prompt}` });
  } else {
    parts.push({ text: prompt });
  }

  const resp = await fetch(
    `${GEMINI_API_URL}/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          responseModalities: ["IMAGE", "TEXT"],
        },
      }),
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    log(`[imagen] Gemini image error (${resp.status}): ${text.substring(0, 300)}`, "imagen");
    throw new Error(`Gemini image error (${resp.status}): ${text.substring(0, 300)}`);
  }

  const data = await resp.json();
  const candidate = data.candidates?.[0]?.content?.parts;
  if (!candidate) {
    throw new Error("Gemini: no candidates in response: " + JSON.stringify(data).substring(0, 300));
  }

  const imagePart = candidate.find((p: any) => p.inlineData?.data);
  if (!imagePart) {
    throw new Error("Gemini: no image in response parts: " + JSON.stringify(candidate.map((p: any) => Object.keys(p))));
  }

  log(`[imagen] Gemini image generated successfully`, "imagen");
  return {
    base64: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || "image/png",
  };
}

export async function generateImageWithOpenAI(
  prompt: string,
  options: {
    model?: string;
    size?: string;
    quality?: string;
  } = {}
): Promise<{ base64: string; mimeType: string }> {
  const OpenAI = (await import("openai")).default;
  const openai = new OpenAI({
    apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
    baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  });

  const model = options.model || "gpt-image-1";
  const size = options.size || "1024x1536";
  const quality = options.quality || "medium";

  log(`[imagen] Generating image via OpenAI (${model}, ${size}): "${prompt.substring(0, 80)}..."`, "imagen");

  const response = await openai.images.generate({
    model,
    prompt,
    n: 1,
    size: size as any,
    quality: quality as any,
  });

  const imageData = response.data?.[0];
  if (!imageData) {
    throw new Error("OpenAI: no image in response");
  }

  if (imageData.b64_json) {
    log(`[imagen] OpenAI image generated (base64)`, "imagen");
    return { base64: imageData.b64_json, mimeType: "image/png" };
  }

  if (imageData.url) {
    log(`[imagen] OpenAI image generated (url), downloading...`, "imagen");
    const resp = await fetch(imageData.url);
    if (!resp.ok) throw new Error(`Failed to download OpenAI image: ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    return { base64: buffer.toString("base64"), mimeType: "image/png" };
  }

  throw new Error("OpenAI: no b64_json or url in response");
}

export async function saveBase64Image(base64: string, mimeType: string, outputDir: string, filename: string): Promise<string> {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const ext = mimeType.includes("jpeg") || mimeType.includes("jpg") ? ".jpg" : ".png";
  const fullFilename = filename.includes(".") ? filename : `${filename}${ext}`;
  const outputPath = path.join(outputDir, fullFilename);

  const buffer = Buffer.from(base64, "base64");
  fs.writeFileSync(outputPath, buffer);

  log(`[imagen] Saved image: ${outputPath} (${(buffer.length / 1024).toFixed(0)}KB)`, "imagen");
  return outputPath;
}
