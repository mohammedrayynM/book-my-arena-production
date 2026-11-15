// TEST ONLY — never load this in production. A fake Razorpay SDK for running the e2e suites against a LOCAL test
// server without network access:   node -r ./tests/helpers/fakeRazorpay.js server.js
// Orders get random ids; payments a test marks as captured are read from RZP_PAYMENTS_FILE (default /tmp/rzp_payments.json).
const Module = require('module'); const crypto = require('crypto');
const payments = global.__rzpPayments = new Map(); // order_id -> [{id,status,amount}]
class FakeRazorpay {
  constructor() {
    this.orders = { create: async (o) => ({ id: 'order_' + crypto.randomBytes(7).toString('hex'), amount: o.amount, currency: o.currency, status: 'created' }), fetchPayments: async (id) => { let f = {}; try { f = JSON.parse(require('fs').readFileSync((process.env.RZP_PAYMENTS_FILE || '/tmp/rzp_payments.json'), 'utf8')); } catch {} return { items: f[id] || payments.get(id) || [] }; }, fetch: async (id) => ({ id, status: 'paid' }) };
    this.payments = { fetch: async (id) => { let f = {}; try { f = JSON.parse(require('fs').readFileSync((process.env.RZP_PAYMENTS_FILE || '/tmp/rzp_payments.json'), 'utf8')); } catch {} for (const [oid, list] of Object.entries(f)) { const p = (list || []).find((x) => x.id === id); if (p) return { order_id: oid, ...p }; } return { id, status: 'captured' }; }, refund: async (id, b) => ({ id: 'rfnd_' + crypto.randomBytes(5).toString('hex'), status: 'processed', amount: b && b.amount }) };
    this.refunds = { fetch: async (id) => ({ id, status: 'processed' }) };
    this.transfers = { create: async () => ({ id: 'trf_x' }) };
  }
  static validateWebhookSignature(body, sig, secret) { return crypto.createHmac('sha256', secret).update(body).digest('hex') === sig; }
}
const orig = Module._load;
Module._load = function (req) { if (req === 'razorpay') return FakeRazorpay; return orig.apply(this, arguments); };
