// D-125: standard task times, the default catalog behind the recommended estimate on the task form. Transcribed from the
// owner's "Sales & Marketing — Task Time Estimation and SLA Guide" (2026-11-11). The organization edits its own copy in
// Settings; these rows are only the default. Times are minutes for one batch of `per` units (e.g. 240–498 min per 100 calls).

export interface StandardTask {
  section: string;
  name: string;
  minMinutes: number;
  maxMinutes: number;
  /** Units in one batch: 1 for "per call", 100 for "per 100 calls". */
  per: number;
  /** The unit counted, as on a measured task ("calls", "posts"). */
  unit: string;
}

type Row = [name: string, min: number, max: number, per: number, unit: string];

const SECTIONS: [string, Row[]][] = [
  ['Sales — Business Development', [
    ['Cold call — basic attempt', 2, 3, 1, 'calls'],
    ['Cold call — detailed conversation', 5, 5, 1, 'calls'],
    ['100 cold calls', 240, 498, 100, 'calls'],
    ['Follow-up call', 3, 5, 1, 'calls'],
    ['WhatsApp follow-up', 2, 3, 1, 'messages'],
    ['Personalized sales email', 5, 10, 1, 'emails'],
    ['Bulk email campaign execution', 30, 60, 1, 'campaigns'],
    ['LinkedIn connection request', 2, 3, 1, 'requests'],
    ['LinkedIn personalized outreach', 5, 8, 1, 'messages'],
    ['Lead research and identification', 5, 10, 1, 'leads'],
    ['Lead qualification', 5, 10, 1, 'leads'],
    ['CRM lead entry', 2, 4, 1, 'leads'],
    ['CRM update after call', 2, 3, 1, 'calls'],
    ['Schedule a meeting', 5, 10, 1, 'meetings'],
    ['Sales meeting', 30, 30, 1, 'meetings'],
    ['Discovery meeting', 30, 45, 1, 'meetings'],
    ['Product/service demo', 30, 60, 1, 'demos'],
    ['Meeting preparation', 10, 20, 1, 'meetings'],
    ['Meeting notes and CRM update', 10, 15, 1, 'meetings'],
    ['Proposal creation', 30, 60, 1, 'proposals'],
    ['Quotation preparation', 15, 30, 1, 'quotations'],
    ['Proposal follow-up', 5, 10, 1, 'follow-ups'],
    ['Negotiation with client', 15, 30, 1, 'sessions'],
    ['Deal closure documentation', 15, 30, 1, 'deals'],
    ['Daily sales report', 15, 20, 1, 'reports'],
    ['EOD reporting', 10, 15, 1, 'days'],
  ]],
  ['Marketing — Content & Social Media', [
    ['Social media post creation and upload', 60, 60, 1, 'posts'],
    ['Simple graphic design', 30, 45, 1, 'designs'],
    ['Carousel post creation', 90, 120, 1, 'carousels'],
    ['LinkedIn article creation', 60, 120, 1, 'articles'],
    ['Blog writing — 500 words', 90, 120, 1, 'blogs'],
    ['Blog writing — 1,000 words', 150, 240, 1, 'blogs'],
    ['Blog SEO optimization', 30, 60, 1, 'blogs'],
    ['Social media caption writing', 15, 30, 1, 'captions'],
    ['Content calendar creation', 120, 180, 1, 'months'],
    ['Content research', 30, 60, 1, 'topics'],
    ['Social media scheduling', 15, 30, 5, 'posts'],
    ['Social media account management', 30, 60, 1, 'days'],
    ['Social media comment responses', 15, 30, 10, 'comments'],
    ['Competitor social media analysis', 60, 120, 1, 'reports'],
  ]],
  ['Marketing — Video & Creative', [
    ['Short reel editing — 30–60 sec', 60, 120, 1, 'reels'],
    ['Reel creation with scripting', 120, 180, 1, 'reels'],
    ['Video script writing', 30, 60, 1, 'scripts'],
    ['Video thumbnail creation', 20, 30, 1, 'thumbnails'],
    ['Promotional video editing', 180, 300, 1, 'videos'],
    ['Basic video recording', 60, 120, 1, 'sessions'],
    ['Video subtitles and captions', 20, 40, 1, 'videos'],
    ['Creative revision', 15, 30, 1, 'revisions'],
    ['Brand promotional design', 60, 120, 1, 'designs'],
    ['Infographic creation', 60, 120, 1, 'infographics'],
  ]],
  ['SEO & Website', [
    ['Keyword research', 60, 120, 1, 'topics'],
    ['On-page SEO optimization', 30, 60, 1, 'pages'],
    ['Technical SEO audit', 180, 300, 1, 'websites'],
    ['Website content update', 30, 60, 1, 'pages'],
    ['Landing page creation', 180, 360, 1, 'pages'],
    ['Website blog upload and formatting', 20, 30, 1, 'blogs'],
    ['Backlink research', 30, 60, 10, 'prospects'],
    ['Competitor SEO analysis', 120, 240, 1, 'reports'],
    ['Google Search Console review', 30, 30, 1, 'reviews'],
    ['Monthly SEO performance report', 120, 180, 1, 'reports'],
  ]],
  ['Paid Advertising & Lead Generation', [
    ['Google Ads campaign setup', 120, 240, 1, 'campaigns'],
    ['Meta Ads campaign setup', 120, 180, 1, 'campaigns'],
    ['Ad copy creation', 30, 60, 1, 'ads'],
    ['Ad creative design', 60, 120, 1, 'creatives'],
    ['Campaign performance monitoring', 30, 60, 1, 'days'],
    ['Campaign optimization', 60, 120, 1, 'campaigns'],
    ['Lead generation research', 60, 60, 25, 'leads'],
    ['Lead list cleaning and validation', 30, 60, 100, 'leads'],
    ['Marketing qualified lead (MQL) review', 3, 5, 1, 'leads'],
    ['Campaign reporting', 60, 120, 1, 'campaigns'],
    ['Email marketing campaign setup', 60, 120, 1, 'campaigns'],
    ['Email template design', 60, 120, 1, 'templates'],
    ['Marketing automation setup', 120, 300, 1, 'workflows'],
  ]],
  ['Meetings, Reporting & Coordination', [
    ['Marketing team meeting', 30, 60, 1, 'meetings'],
    ['Sales & Marketing alignment meeting', 30, 45, 1, 'meetings'],
    ['Campaign planning meeting', 45, 60, 1, 'meetings'],
    ['Weekly marketing report', 60, 120, 1, 'reports'],
    ['Monthly marketing performance report', 180, 300, 1, 'reports'],
    ['Task planning and assignment', 30, 60, 1, 'days'],
    ['Campaign strategy development', 120, 240, 1, 'strategies'],
    ['Stakeholder presentation preparation', 60, 180, 1, 'presentations'],
    ['Marketing budget planning', 120, 240, 1, 'plans'],
  ]],
];

export const DEFAULT_STANDARD_TASKS: StandardTask[] = SECTIONS.flatMap(([section, rows]) =>
  rows.map(([name, minMinutes, maxMinutes, per, unit]) => ({ section, name, minMinutes, maxMinutes, per, unit })),
);

/**
 * The recommended estimate for `quantity` units (default: one batch): the average of the range, scaled to the quantity,
 * in hours rounded to the quarter hour and kept within a task's 0.25–200 h estimate.
 */
export function recommendedHours(t: StandardTask, quantity: number = t.per): number {
  const hours = (((t.minMinutes + t.maxMinutes) / 2) * (quantity / t.per)) / 60;
  return Math.min(200, Math.max(0.25, Math.round(hours * 4) / 4));
}
