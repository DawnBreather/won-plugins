#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, dirname, basename, extname, join } from "node:path";

// --- Setup ---

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("GEMINI_API_KEY environment variable is required");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });
const MODEL = "gemini-3.1-flash-image-preview";
const DEFAULT_OUTPUT_DIR = resolve(
  dirname(new URL(import.meta.url).pathname),
  "..",
  "generated"
);

// --- Helpers ---

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

function mimeFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
  };
  return map[ext] || "image/png";
}

async function resolveOutputPath(
  outputPath: string | undefined,
  prefix: string
): Promise<string> {
  let dir: string;
  let filename: string;

  if (!outputPath) {
    dir = DEFAULT_OUTPUT_DIR;
    filename = `${prefix}_${timestamp()}.png`;
  } else {
    // Check if outputPath looks like a directory (ends with / or has no extension)
    const ext = extname(outputPath);
    if (!ext || outputPath.endsWith("/")) {
      dir = resolve(outputPath);
      filename = `${prefix}_${timestamp()}.png`;
    } else {
      dir = dirname(resolve(outputPath));
      filename = basename(outputPath);
    }
  }

  await mkdir(dir, { recursive: true });
  return join(dir, filename);
}

async function readImageAsBase64(imagePath: string): Promise<{
  data: string;
  mimeType: string;
}> {
  const absPath = resolve(imagePath);
  const buffer = await readFile(absPath);
  return {
    data: buffer.toString("base64"),
    mimeType: mimeFromPath(absPath),
  };
}

type ContentPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

async function generateWithGemini(
  contents: string | ContentPart[],
  config: {
    aspectRatio?: string;
    imageSize?: string;
  }
): Promise<{ imageBase64: string; mimeType: string; text?: string }> {
  const imageConfig: Record<string, string> = {};
  if (config.aspectRatio) imageConfig.aspectRatio = config.aspectRatio;
  if (config.imageSize) imageConfig.imageSize = config.imageSize;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig,
    },
  });

  const candidates = response.candidates;
  if (!candidates || candidates.length === 0) {
    throw new Error("No candidates in Gemini response");
  }

  const parts = candidates[0].content?.parts;
  if (!parts || parts.length === 0) {
    throw new Error("No parts in Gemini response");
  }

  let imageBase64: string | undefined;
  let mimeType = "image/png";
  let text: string | undefined;

  for (const part of parts) {
    if (part.inlineData) {
      imageBase64 = part.inlineData.data as string;
      mimeType = (part.inlineData.mimeType as string) || "image/png";
    } else if (part.text) {
      text = part.text;
    }
  }

  if (!imageBase64) {
    throw new Error(
      `Gemini did not return an image. Text response: ${text || "(none)"}`
    );
  }

  return { imageBase64, mimeType, text };
}

// --- MCP Server ---

const server = new McpServer({
  name: "nano-banana",
  version: "1.0.0",
});

// Tool: generate_image
server.tool(
  "generate_image",
  "Generate an image from a text prompt using Gemini",
  {
    prompt: z.string().describe("Text prompt describing the image to generate"),
    aspectRatio: z
      .enum(["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"])
      .default("1:1")
      .describe("Aspect ratio of the output image"),
    outputPath: z
      .string()
      .optional()
      .describe(
        "File path or directory for the output image. Defaults to ./generated/"
      ),
  },
  async ({ prompt, aspectRatio, outputPath }) => {
    try {
      const outFile = await resolveOutputPath(outputPath, "gen");
      const { imageBase64, mimeType, text } = await generateWithGemini(
        prompt,
        { aspectRatio }
      );

      const buffer = Buffer.from(imageBase64, "base64");
      await writeFile(outFile, buffer);

      return {
        content: [
          {
            type: "text" as const,
            text: `Image saved to: ${outFile}${text ? `\n\nModel notes: ${text}` : ""}`,
          },
          {
            type: "image" as const,
            data: imageBase64,
            mimeType,
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Error generating image: ${(err as Error).message}`,
          },
        ],
      };
    }
  }
);

// Tool: edit_image
server.tool(
  "edit_image",
  "Edit an existing image using a text prompt. Can also use reference images for style/content guidance.",
  {
    imagePath: z.string().describe("Path to the input image to edit"),
    prompt: z
      .string()
      .describe("Text prompt describing the desired edits"),
    aspectRatio: z
      .enum(["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"])
      .optional()
      .describe("Aspect ratio of the output image"),
    referenceImages: z
      .array(z.string())
      .optional()
      .describe("Additional reference image paths for style/content guidance"),
    outputPath: z
      .string()
      .optional()
      .describe(
        "File path or directory for the output image. Defaults to ./generated/"
      ),
  },
  async ({ imagePath, prompt, aspectRatio, referenceImages, outputPath }) => {
    try {
      const outFile = await resolveOutputPath(outputPath, "edit");

      // Build content parts: text prompt + input image + reference images
      const contentParts: ContentPart[] = [{ text: prompt }];

      const mainImage = await readImageAsBase64(imagePath);
      contentParts.push({ inlineData: mainImage });

      if (referenceImages && referenceImages.length > 0) {
        for (const refPath of referenceImages) {
          const refImage = await readImageAsBase64(refPath);
          contentParts.push({ inlineData: refImage });
        }
      }

      const { imageBase64, mimeType, text } = await generateWithGemini(
        contentParts,
        { aspectRatio }
      );

      const buffer = Buffer.from(imageBase64, "base64");
      await writeFile(outFile, buffer);

      return {
        content: [
          {
            type: "text" as const,
            text: `Edited image saved to: ${outFile}\nSource: ${imagePath}${text ? `\n\nModel notes: ${text}` : ""}`,
          },
          {
            type: "image" as const,
            data: imageBase64,
            mimeType,
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Error editing image: ${(err as Error).message}`,
          },
        ],
      };
    }
  }
);

// Tool: upscale_image
server.tool(
  "upscale_image",
  "Upscale and restore an image to high quality using AI enhancement",
  {
    imagePath: z.string().describe("Path to the image to upscale"),
    outputPath: z
      .string()
      .optional()
      .describe(
        "File path or directory for the output image. Defaults to ./generated/"
      ),
  },
  async ({ imagePath, outputPath }) => {
    try {
      const outFile = await resolveOutputPath(outputPath, "upscale");

      const mainImage = await readImageAsBase64(imagePath);
      const contentParts: ContentPart[] = [
        {
          text: "Faithfully restore this image with high fidelity to modern photograph quality, in full color, upscale to 4K",
        },
        { inlineData: mainImage },
      ];

      const { imageBase64, mimeType, text } = await generateWithGemini(
        contentParts,
        { imageSize: "4K" }
      );

      const buffer = Buffer.from(imageBase64, "base64");
      await writeFile(outFile, buffer);

      return {
        content: [
          {
            type: "text" as const,
            text: `Upscaled image saved to: ${outFile}\nSource: ${imagePath}${text ? `\n\nModel notes: ${text}` : ""}`,
          },
          {
            type: "image" as const,
            data: imageBase64,
            mimeType,
          },
        ],
      };
    } catch (err) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `Error upscaling image: ${(err as Error).message}`,
          },
        ],
      };
    }
  }
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
