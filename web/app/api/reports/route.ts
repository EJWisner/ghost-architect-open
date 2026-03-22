import { NextResponse } from 'next/server';
import { listReports, readReport } from '@/lib/ghost';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const file = searchParams.get('file');

  if (file) {
    const content = readReport(file);
    if (!content) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ content });
  }

  const reports = listReports();
  return NextResponse.json({ reports });
}
