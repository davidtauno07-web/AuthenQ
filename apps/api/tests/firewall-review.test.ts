import { describe, expect, it } from 'vitest';
import { applyCombinationRisk, classifyColumn, K_MIN, profileValues } from '../src/domain/firewall.js';
import { firewallGate } from '../src/services/firewall.js';

const rep = <T,>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));

describe('firewall value profiling', () => {
  it('detects phone numbers from values when the column name gives no hint', () => {
    const f = classifyColumn({ table: 'c', name: 'contact_1', values: rep(60, (i) => `+264 81 ${String(100 + i).padStart(3, '0')} ${String(1000 + i * 7)}`), totalRows: 60 });
    expect(f.classification).toBe('SENSITIVE');
    expect(f.entityType).toBe('PHONE');
    expect(f.evidence.join(' ')).toMatch(/phone-like/);
    expect(f.stats.profile!.prefixes[0]).toEqual({ prefix: '+264', share: 1 });
  });

  it('flags personal names found only from values for review', () => {
    const first = ['Anna', 'Peter', 'Maria', 'Johan', 'Selma', 'Tomas', 'Ndapewa', 'Frieda'];
    const last = ['Shikongo', 'Muller', 'Nghipondoka', 'Smith', 'Amutenya', 'Visser'];
    const f = classifyColumn({ table: 'c', name: 'holder', values: rep(48, (i) => `${first[i % 8]} ${last[i % 6]}`), totalRows: 48 });
    expect(f.entityType).toBe('PERSON_NAME');
    expect(f.needsReview).toBe(true);
  });

  it('lowers confidence and records a limitation when name and values disagree', () => {
    const f = classifyColumn({ table: 'c', name: 'email', values: rep(40, (i) => `segment-${i % 4}`), totalRows: 40 });
    expect(f.confidence).toBeLessThanOrEqual(0.6);
    expect(f.needsReview).toBe(true);
    expect(f.limitations.join(' ')).toMatch(/only 0% of sampled values/);
  });

  it('raises confidence when name and values agree', () => {
    const f = classifyColumn({ table: 'c', name: 'email', values: rep(40, (i) => `user${i}@example.com`), totalRows: 40 });
    expect(f.classification).toBe('SENSITIVE');
    expect(f.needsReview).toBe(false);
    expect(f.stats.profile!.emailDomains).toEqual([{ domain: 'example.com', share: 1 }]);
  });

  it('suppresses profile groups smaller than K_MIN so single values cannot be read back', () => {
    const p = profileValues([...rep(10, () => 'ab@common.org'), 'x@rare-person-domain.com']);
    expect(p.emailDomains.map((d) => d.domain)).toEqual(['common.org']);
    expect(p.suppressedBelow).toBe(K_MIN);
    expect(JSON.stringify(p)).not.toContain('rare-person-domain');
  });

  it('records sampling limitations', () => {
    const f = classifyColumn({ table: 'c', name: 'amount', values: rep(10, (i) => String(i)), totalRows: 5000 });
    expect(f.limitations.join(' ')).toMatch(/Only 10 non-empty values/);
    expect(f.limitations.join(' ')).toMatch(/sample of 10 of 5000 rows/);
  });

  it('marks quasi-identifiers as a combination risk', () => {
    const cols = [
      { name: 'zip', finding: classifyColumn({ table: 'p', name: 'zip', values: rep(40, (i) => String(10000 + (i % 7))), totalRows: 40 }) },
      { name: 'birth_date', finding: classifyColumn({ table: 'p', name: 'birth_date', values: rep(40, (i) => `1980-01-${String((i % 28) + 1).padStart(2, '0')}`), totalRows: 40 }) },
      { name: 'amount', finding: classifyColumn({ table: 'p', name: 'amount', values: rep(40, (i) => String(i)), totalRows: 40 }) },
    ];
    applyCombinationRisk(cols);
    expect(cols[0]!.finding.limitations.join(' ')).toMatch(/Combination risk: together with birth_date/);
    expect(cols[1]!.finding.needsReview).toBe(true);
    expect(cols[2]!.finding.limitations.join(' ')).not.toMatch(/Combination risk/);
  });
});

describe('firewall classification review gate', () => {
  const base = { name: 'x', classification: 'SENSITIVE', decision: 'REPLACE', decisionSource: 'SYSTEM', entityType: 'EMAIL' };
  const gate = (c: Partial<typeof base> & { needsReview?: boolean; reviewStatus?: string }) => firewallGate({ status: 'NEEDS_REVIEW', currentScanId: 's', tables: [{ name: 't', columns: [{ ...base, ...c }] }] });

  it('blocks sign-off while an uncertain classification is unreviewed', () => {
    expect(gate({ needsReview: true, reviewStatus: 'PENDING' }).reasons.join(' ')).toMatch(/uncertain classification/);
    expect(gate({ needsReview: true, reviewStatus: 'APPROVED' }).ready).toBe(true);
    expect(gate({ needsReview: true, reviewStatus: 'CHANGED' }).ready).toBe(true);
  });
  it('blocks sign-off while a classification is rejected', () => {
    expect(gate({ needsReview: false, reviewStatus: 'REJECTED' }).reasons.join(' ')).toMatch(/rejected/);
  });
  it('lets confident classifications through without per-column review', () => {
    expect(gate({ needsReview: false, reviewStatus: 'PENDING' }).ready).toBe(true);
  });
});

describe.runIf(process.env.CI || process.env.DEMO_PASSWORD)('firewall classification review (database)', () => {
  it('requires review of uncertain columns, records reasons and blocks sign-off until resolved', async () => {
    const { prisma } = await import('../src/lib/prisma.js');
    const fw = await import('../src/services/firewall.js');
    const { drainJobs } = await import('../src/worker/handlers.js');
    const org = await prisma.organization.findUnique({ where: { slug: 'northwind-demo' } });
    if (!org) return;
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@authenq.demo' } });
    const ctx = { orgId: org.id, userId: admin.id, actorType: 'USER', actorLabel: 'test', roleKey: 'ADMIN', permissions: new Set<never>() } as never;
    const source = await fw.createSource(ctx, { name: `review-test-${Date.now()}`, kind: 'UPLOAD' } as never);
    try {
      await fw.ingestTables(org.id, source.id, [
        { name: 'people', rows: rep(40, (i) => ({ person_id: `P-${1000 + i}`, email: `segment-${i % 3}`, amount: String(i * 3) })) },
      ]);
      await fw.startScan(ctx, source.id);
      await drainJobs();
      const cols = await prisma.sourceColumn.findMany({ where: { sourceId: source.id } });
      const email = cols.find((c) => c.name === 'email')!;
      expect(email.needsReview).toBe(true);
      expect(email.reviewStatus).toBe('PENDING');
      await expect(fw.signOff(ctx, source.id)).rejects.toThrow();

      await expect(fw.reviewClassification(ctx, email.id, { action: 'CHANGE', classification: 'NON_SENSITIVE' })).rejects.toThrow(/reason/);
      await expect(fw.reviewClassification(ctx, email.id, { action: 'REJECT' })).rejects.toThrow(/reason/);
      const bulk = await fw.approveClassifications(ctx, source.id, {});
      expect((await prisma.sourceColumn.findUniqueOrThrow({ where: { id: email.id } })).reviewStatus).toBe('PENDING');
      expect(bulk.approved).toBeGreaterThanOrEqual(0);

      await fw.reviewClassification(ctx, email.id, { action: 'REJECT', reason: 'Not an email column.' });
      let detail = await fw.getSourceDetail(ctx, source.id);
      expect(detail.gate.reasons.join(' ')).toMatch(/rejected/);

      await fw.reviewClassification(ctx, email.id, { action: 'CHANGE', classification: 'NON_SENSITIVE', reason: 'Holds a segment code, not an email.' });
      const changed = await prisma.sourceColumn.findUniqueOrThrow({ where: { id: email.id } });
      expect(changed).toMatchObject({ classification: 'NON_SENSITIVE', systemClassification: 'SENSITIVE', reviewStatus: 'CHANGED', reviewReason: 'Holds a segment code, not an email.' });
      expect(await prisma.activityLog.count({ where: { orgId: org.id, action: 'firewall.classification_reviewed', resourceId: email.id } })).toBe(2);

      await fw.approveClassifications(ctx, source.id, { includeUncertain: true, reason: 'Reviewed in test.' });
      await prisma.sourceColumn.updateMany({ where: { sourceId: source.id, classification: 'NEEDS_DECISION' }, data: { decisionSource: 'HUMAN' } });
      detail = await fw.getSourceDetail(ctx, source.id);
      expect(detail.findings[email.id]!.limitations.length).toBeGreaterThan(0);
      expect(detail.gate.ready).toBe(true);

      // A rescan keeps the human classification.
      await fw.startScan(ctx, source.id);
      await drainJobs();
      expect((await prisma.sourceColumn.findUniqueOrThrow({ where: { id: email.id } })).classification).toBe('NON_SENSITIVE');
    } finally {
      await prisma.dataSource.delete({ where: { id: source.id } }).catch(() => undefined);
      await prisma.$disconnect();
    }
  }, 60_000);
});
