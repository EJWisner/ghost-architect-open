import { NextResponse } from 'next/server';
import { listProjectSummaries } from '@/lib/ghost';

export async function GET() {
  const projects = listProjectSummaries();
  return NextResponse.json({ projects });
}
