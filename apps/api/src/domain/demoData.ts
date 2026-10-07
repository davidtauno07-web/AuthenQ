import { createRng } from '../lib/prng.js';

/**
 * Deterministic "Support Tickets" demo source: 300 customers and 800 tickets.
 * This is fictional organizational data that plays the role of REAL data for
 * the demo. It is generated, so the same seed always yields the same rows.
 */
export const DEMO_LABELS = ['Billing', 'Technical Issue', 'Account Access', 'Shipping', 'Cancellation', 'Feature Request'] as const;
export type DemoLabel = (typeof DEMO_LABELS)[number];

const FIRST = ['Maria', 'James', 'Aisha', 'Chen', 'Olga', 'Lucas', 'Priya', 'Tomas', 'Fatima', 'Noah', 'Elena', 'Marek', 'Sofia', 'Daniel', 'Hana', 'Ivan', 'Grace', 'Omar', 'Lena', 'Victor', 'Zara', 'Peter', 'Ines', 'Kofi', 'Mila', 'Arjun', 'Freya', 'Jonas', 'Leila', 'Mateo'];
const LAST = ['Novak', 'Smith', 'Khan', 'Wang', 'Petrova', 'Silva', 'Patel', 'Horvat', 'Haddad', 'Johnson', 'Rossi', 'Kowalski', 'Garcia', 'Muller', 'Tanaka', 'Ivanov', 'Brown', 'Farouk', 'Larsen', 'Dubois', 'Ahmed', 'Nagy', 'Costa', 'Mensah', 'Kral', 'Rao', 'Berg', 'Schmidt', 'Rahimi', 'Lopez'];
const CITIES = ['Tallinn', 'Riga', 'Vilnius', 'Helsinki', 'Stockholm', 'Oslo', 'Copenhagen', 'Berlin', 'Warsaw', 'Prague'];
const STREETS = ['Harbor', 'Mill', 'Station', 'Market', 'Church', 'Garden', 'River', 'Park', 'King', 'Queen'];
const TIERS = ['Basic', 'Pro', 'Enterprise'];
const CHANNELS = ['email', 'chat', 'phone', 'web'];

const OPENERS = ['Hello support team.', 'Hi there.', 'Good morning.', 'Hello,', 'Hi, I need some help.', 'Dear support.'];
const CLOSERS = ['Thanks in advance.', 'Please get back to me soon.', 'Looking forward to your reply.', 'Thank you.', 'Appreciate the help.', 'Regards.'];

export const ISSUE_SENTENCES: Record<DemoLabel, string[]> = {
  Billing: [
    'I was charged twice for my subscription this month.',
    'My invoice shows an amount that does not match my plan.',
    'The refund you promised has not arrived on my card.',
    'I need a copy of the invoice for last quarter with our VAT number.',
    'Why did my monthly payment go up without notice?',
  ],
  'Technical Issue': [
    'The dashboard crashes every time I open the reports page.',
    'Your app shows an error 500 when I try to save changes.',
    'The sync between the mobile app and the website stopped working.',
    'Exports time out after a few minutes and never finish.',
    'Since the last update the page loads extremely slowly.',
  ],
  'Account Access': [
    'I cannot log in even after resetting my password.',
    'The two-factor code never arrives on my phone.',
    'My account was locked after a few login attempts.',
    'I no longer have access to the email on my account and need to change it.',
    'A colleague left and we need to transfer ownership of the account.',
  ],
  Shipping: [
    'My order still has not arrived after two weeks.',
    'The tracking number you sent does not work.',
    'The package was delivered to the wrong address.',
    'The box arrived damaged and one item is missing.',
    'Can you change the delivery address for my pending order?',
  ],
  Cancellation: [
    'I want to cancel my subscription at the end of this billing period.',
    'Please close my account and delete my data.',
    'We are moving to another provider and need to end the contract.',
    'How do I stop the automatic renewal of my plan?',
    'Please cancel the order I placed yesterday.',
  ],
  'Feature Request': [
    'It would be great if reports could be scheduled weekly.',
    'Could you add a dark mode to the application?',
    'We would like an integration with our accounting software.',
    'Please consider adding bulk editing for records.',
    'Is there a plan to support exporting to Excel directly?',
  ],
};

const DETAILS: Record<DemoLabel, string[]> = {
  Billing: ['The charge appeared on my statement on Monday.', 'I have attached a screenshot of the payment.', 'Our finance team needs this resolved before month end.'],
  'Technical Issue': ['I tried two different browsers with the same result.', 'Clearing the cache did not help.', 'Several people on my team see the same problem.'],
  'Account Access': ['I have tried the reset link three times.', 'This is blocking my whole team.', 'I can verify my identity if needed.'],
  Shipping: ['The order was marked as shipped last Tuesday.', 'I need the items for an event this weekend.', 'Nobody was home when the courier came.'],
  Cancellation: ['We are not using the service enough to justify the cost.', 'Please confirm once this is done.', 'I do not want to be charged again.'],
  'Feature Request': ['Many of our users have asked for this.', 'This would save us hours every week.', 'Competitor tools already offer something similar.'],
};

export interface DemoDataset {
  customers: Record<string, string | number>[];
  tickets: Record<string, string | number>[];
  /** Hidden ground truth used only by the seed to simulate human labelers. */
  truth: Map<string, DemoLabel>;
}

export function generateDemoDataset(seed = 20260101): DemoDataset {
  const rng = createRng(seed);
  const customers: Record<string, string | number>[] = [];
  for (let i = 0; i < 300; i++) {
    const first = rng.pick(FIRST);
    const last = rng.pick(LAST);
    const year = rng.int(1955, 2003);
    customers.push({
      customer_id: `CUS-${10001 + i}`,
      full_name: `${first} ${last}`,
      email: `${first}.${last}${rng.int(1, 99)}@${rng.pick(['mailbox.ee', 'post.lv', 'inbox.fi', 'web.de', 'mail.pl'])}`.toLowerCase(),
      phone: `+372 5${rng.int(100, 999)} ${rng.int(1000, 9999)}`,
      street_address: `${rng.int(1, 120)} ${rng.pick(STREETS)} Street`,
      postal_code: String(rng.int(10000, 99999)),
      date_of_birth: `${year}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`,
      city: rng.pick(CITIES),
      plan_tier: rng.weighted([['Basic', 5], ['Pro', 3], ['Enterprise', 1]] as const),
      signup_date: `20${rng.int(18, 25)}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`,
      lifetime_value: Math.round(rng.normal(1200, 450) * 100) / 100,
    });
  }
  void TIERS;
  const tickets: Record<string, string | number>[] = [];
  const truth = new Map<string, DemoLabel>();
  const weights = [['Billing', 22], ['Technical Issue', 26], ['Account Access', 16], ['Shipping', 14], ['Cancellation', 10], ['Feature Request', 12]] as const;
  for (let i = 0; i < 800; i++) {
    const c = customers[rng.int(0, customers.length - 1)]!;
    const label = rng.weighted(weights) as DemoLabel;
    const parts = [rng.pick(OPENERS), rng.pick(ISSUE_SENTENCES[label])];
    if (rng.next() < 0.7) parts.push(rng.pick(DETAILS[label]));
    const mention = rng.next();
    if (mention < 0.25) parts.push(`You can reach me at ${c.phone}.`);
    else if (mention < 0.45) parts.push(`My account email is ${c.email}.`);
    else if (mention < 0.6) parts.push(`My customer number is ${c.customer_id}.`);
    parts.push(`${rng.pick(CLOSERS)} ${String(c.full_name).split(' ')[0]}`);
    const legacy = rng.next() < 0.9 ? label : rng.pick(DEMO_LABELS);
    const ticketId = `TKT-${200001 + i}`;
    truth.set(ticketId, label);
    tickets.push({
      ticket_id: ticketId,
      customer_id: c.customer_id as string,
      created_at: new Date(Date.UTC(2026, 0, 1) + rng.int(0, 240) * 86_400_000 + rng.int(0, 86_399) * 1000).toISOString(),
      channel: rng.pick(CHANNELS),
      subject: rng.pick(ISSUE_SENTENCES[label]).replace(/\.$/, '').slice(0, 60),
      body: parts.join(' '),
      priority: rng.weighted([['low', 3], ['medium', 5], ['high', 2], ['urgent', 1]] as const),
      legacy_category: legacy,
      handle_minutes: Math.max(2, Math.round(rng.normal(label === 'Technical Issue' ? 38 : 18, 8))),
    });
  }
  return { customers, tickets, truth };
}

/** Recovers the intended label of a (synthetic) ticket text from its issue sentence, for seeding simulated human labels. */
export function demoTruthForText(text: string): DemoLabel | null {
  for (const label of DEMO_LABELS) for (const s of ISSUE_SENTENCES[label]) if (text.includes(s)) return label;
  return null;
}

export const DEMO_GUIDELINE = `# Support ticket intent — labeling guidelines

Label each ticket with the single **primary intent** of the customer.

## Labels
- **Billing** — charges, invoices, refunds, payment amounts, VAT.
- **Technical Issue** — errors, crashes, slowness, sync or export failures.
- **Account Access** — login, password, two-factor, locked accounts, ownership transfer.
- **Shipping** — delivery status, tracking, wrong address, damaged parcels.
- **Cancellation** — ending a subscription, contract, renewal or order; account deletion.
- **Feature Request** — suggestions for new capabilities.

## Decision rules
1. If the customer asks to **cancel or delete**, choose Cancellation even if billing is mentioned.
2. A refund request for a charge is Billing; a refund because an order never arrived is Shipping.
3. "Cannot log in" is Account Access, even if an error message is shown.
4. When two intents are present, label the one the customer asks us to act on.

## Edge cases
- Greetings, signatures and contact details do not affect the label.
- If the text is unreadable or empty, flag the task instead of guessing.
`;

export const DEMO_DECISION_TREE = {
  question: 'Does the customer ask to cancel, close or delete something?',
  yes: { label: 'Cancellation' },
  no: {
    question: 'Is the problem about signing in or controlling the account?',
    yes: { label: 'Account Access' },
    no: {
      question: 'Is it about money (charges, invoices, refunds for a charge)?',
      yes: { label: 'Billing' },
      no: {
        question: 'Is it about a delivery or parcel?',
        yes: { label: 'Shipping' },
        no: { question: 'Is something broken or failing?', yes: { label: 'Technical Issue' }, no: { label: 'Feature Request' } },
      },
    },
  },
};

export const DEMO_RULES = [
  { id: 'R1-cancel', label: 'Cancellation', keywords: ['cancel my subscription', 'close my account', 'automatic renewal', 'end the contract'], description: 'Explicit cancellation phrases map to Cancellation (guideline rule 1).' },
  { id: 'R2-2fa', label: 'Account Access', keywords: ['two factor code', 'cannot log in'], description: 'Sign-in failures map to Account Access (guideline rule 3).' },
];
