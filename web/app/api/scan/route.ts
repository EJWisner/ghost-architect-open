import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import os from 'os';
import AdmZip from 'adm-zip';

export const runtime = 'nodejs';
export const maxDuration = 300;

// Build a simple fileMap from a zip buffer
function buildFileMapFromZip(buffer: Buffer): Record<string, string> {
  const zip     = new AdmZip(buffer);
  const entries = zip.getEntries();
  const fileMap: Record<string, string> = {};
  const skipExts = new Set(['.jpg','.jpeg','.png','.gif','.webp','.svg','.ico','.woff','.woff2','.ttf','.eot','.pdf','.zip','.gz','.tar','.lock']);
  const skipDirs = new Set(['node_modules','.git','vendor','.next','dist','build','coverage','.cache']);

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const parts = entry.entryName.split('/');
    if (parts.some(p => skipDirs.has(p))) continue;
    const ext = path.extname(entry.entryName).toLowerCase();
    if (skipExts.has(ext)) continue;
    if (entry.header.size > 200_000) continue; // skip huge files

    try {
      const content = entry.getData().toString('utf8');
      if (content.length > 0) fileMap[entry.entryName] = content;
    } catch { /* skip binary */ }
  }
  return fileMap;
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file     = formData.get('file') as File | null;
    const mode     = (formData.get('mode') as string) || 'poi';
    const apiKey   = formData.get('apiKey') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const buffer  = Buffer.from(await file.arrayBuffer());
    const fileMap = buildFileMapFromZip(buffer);
    const fileCount = Object.keys(fileMap).length;

    if (fileCount === 0) {
      return NextResponse.json({ error: 'No readable files found in ZIP' }, { status: 400 });
    }

    // Build context string
    let context = '';
    for (const [fp, content] of Object.entries(fileMap)) {
      context += `\n\n=== FILE: ${fp} ===\n${content}`;
    }

    // Get API key
    const key = apiKey || process.env.ANTHROPIC_API_KEY;
    if (!key) {
      return NextResponse.json({ error: 'No API key provided' }, { status: 400 });
    }

    // Import Anthropic dynamically (avoid bundler issues)
    const Anthropic = (await import('@anthropic-ai/sdk')).default;
    const client    = new Anthropic({ apiKey: key });

    // Build prompt based on mode
    let system = '';
    let prompt = '';

    if (mode === 'poi') {
      const { buildSystemPOI } = await import('../../../../prompts/index.js' as any);
      system = buildSystemPOI({ junior: 85, mid: 125, senior: 200 });
      prompt = `Analyze this codebase (${fileCount} files) for Points of Interest.\n\n${context}`;
    } else if (mode === 'conflict') {
      const { buildSystemConflict, buildConflictPrompt } = await import('../../../../prompts/conflict.js' as any);
      system = buildSystemConflict();
      prompt = buildConflictPrompt({ passNum: 1, totalPasses: 1, totalFiles: fileCount, context, priorContext: '' });
    } else if (mode === 'blast') {
      const { SYSTEM_BLAST } = await import('../../../../prompts/index.js' as any);
      system = SYSTEM_BLAST;
      prompt = `Analyze this codebase for blast radius. ${context}`;
    }

    // Stream response
    const encoder = new TextEncoder();
    const stream  = new ReadableStream({
      async start(controller) {
        try {
          const stream = client.messages.stream({
            model:      'claude-sonnet-4-5',
            max_tokens: 8096,
            system,
            messages:   [{ role: 'user', content: prompt }],
          });

          for await (const chunk of stream) {
            if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
              controller.enqueue(encoder.encode(chunk.delta.text));
            }
          }
          controller.close();
        } catch (err: any) {
          controller.enqueue(encoder.encode(`\n\nError: ${err.message}`));
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-File-Count':  String(fileCount),
        'Transfer-Encoding': 'chunked',
      }
    });

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
