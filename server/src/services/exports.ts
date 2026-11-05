import PDFDocument from 'pdfkit';
import { formatHours } from '../domain.js';
import { formatInZone } from '../notify/format.js';
import type { Accountability } from './reports.js';

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  // Neutralise spreadsheet formulas (also tab and CR starts, S-13) and quote anything with separators.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** RPT-03 formula-guarded CSV; every export uses this. */
export function csvRows(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n');
}

const hrs = (h: number | null) => (h == null ? '' : h.toFixed(1));

export function accountabilityCsv(a: Accountability, timeZone: string): string {
  const header = [
    ['TaskWatch accountability report'],
    ['Scope', a.scope],
    ['Period', `Last ${a.days} days`],
    ['Generated', formatInZone(a.generatedAt, timeZone)],
    [],
  ];
  const entities = [
    ['By entity'],
    ['Entity', 'Open', 'On track', 'Amber (L0–L1)', 'Red (L2–L3)', 'Blocked', 'Longest silence (h)', 'Longest-silent task'],
    ...a.byEntity.map((e) => [
      e.entityName,
      e.open,
      e.onTrack,
      e.amber,
      e.red,
      e.blocked,
      hrs(e.longestSilenceHours),
      e.longestSilenceTask ? `#${e.longestSilenceTask.id} ${e.longestSilenceTask.title} (${e.longestSilenceTask.assignee})` : '',
    ]),
    [],
  ];
  const people = [
    ['By person'],
    ['Person', 'Entity', 'Open tasks', 'Avg first response (h)', 'Escalations (L1+)', 'Closed', 'On time', 'On-time %'],
    ...a.byPerson.map((p) => [p.name, p.entityId, p.open, hrs(p.avgFirstResponseHours), p.escalations, p.closed, p.onTime, p.onTimePct ?? '']),
  ];
  return csvRows([...header, ...entities, ...people]) + '\n';
}

type Col = { label: string; width: number; align?: 'left' | 'right' };

function table(doc: PDFKit.PDFDocument, cols: Col[], rows: string[][]): void {
  const left = doc.page.margins.left;
  const rowH = 18;
  const drawRow = (cells: string[], bold: boolean) => {
    if (doc.y + rowH > doc.page.height - doc.page.margins.bottom) doc.addPage();
    const y = doc.y;
    let x = left;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5);
    cols.forEach((c, i) => {
      doc.text(cells[i] ?? '', x + 3, y + 5, { width: c.width - 6, align: c.align ?? 'left', lineBreak: false, ellipsis: true });
      x += c.width;
    });
    doc
      .moveTo(left, y + rowH)
      .lineTo(x, y + rowH)
      .strokeColor(bold ? '#94a3b8' : '#e2e8f0')
      .lineWidth(bold ? 1 : 0.5)
      .stroke();
    doc.x = left;
    doc.y = y + rowH;
  };
  drawRow(
    cols.map((c) => c.label),
    true,
  );
  for (const r of rows) drawRow(r, false);
  doc.moveDown(1);
}

export function accountabilityPdf(a: Accountability, timeZone: string): PDFKit.PDFDocument {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36, info: { Title: 'TaskWatch accountability report' } });
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#0f172a').text('TaskWatch — accountability report');
  doc
    .font('Helvetica')
    .fontSize(9.5)
    .fillColor('#475569')
    .text(`${a.scope} · last ${a.days} days · generated ${formatInZone(a.generatedAt, timeZone)}`);
  doc.moveDown(1).fillColor('#0f172a');

  doc.font('Helvetica-Bold').fontSize(11).text('By entity');
  doc.moveDown(0.3);
  table(
    doc,
    [
      { label: 'Entity', width: 190 },
      { label: 'Open', width: 50, align: 'right' },
      { label: 'On track', width: 60, align: 'right' },
      { label: 'Amber', width: 55, align: 'right' },
      { label: 'Red', width: 50, align: 'right' },
      { label: 'Blocked', width: 55, align: 'right' },
      { label: 'Longest silence', width: 85, align: 'right' },
      { label: 'Longest-silent task', width: 225 },
    ],
    a.byEntity.map((e) => [
      e.entityName,
      String(e.open),
      String(e.onTrack),
      String(e.amber),
      String(e.red),
      String(e.blocked),
      e.longestSilenceHours == null ? '—' : formatHours(e.longestSilenceHours),
      e.longestSilenceTask ? `#${e.longestSilenceTask.id} ${e.longestSilenceTask.title} (${e.longestSilenceTask.assignee})` : '—',
    ]),
  );

  doc.font('Helvetica-Bold').fontSize(11).text('By person');
  doc.moveDown(0.3);
  table(
    doc,
    [
      { label: 'Person', width: 170 },
      { label: 'Entity', width: 70 },
      { label: 'Open tasks', width: 70, align: 'right' },
      { label: 'Avg first response', width: 110, align: 'right' },
      { label: 'Escalations (L1+)', width: 105, align: 'right' },
      { label: 'Closed', width: 60, align: 'right' },
      { label: 'On time', width: 60, align: 'right' },
      { label: 'On-time %', width: 75, align: 'right' },
    ],
    a.byPerson.map((p) => [
      p.name,
      p.entityId,
      String(p.open),
      p.avgFirstResponseHours == null ? '—' : `${p.avgFirstResponseHours.toFixed(1)} h`,
      String(p.escalations),
      String(p.closed),
      String(p.onTime),
      p.onTimePct == null ? '—' : `${p.onTimePct}%`,
    ]),
  );
  doc.end();
  return doc;
}
