process.env.JWT_SECRET = 'customer-auth-test-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const { verifyCustomer } = require('../middleware/auth');

function responseStub() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

function invoke(token) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} };
  const res = responseStub();
  let continued = false;
  verifyCustomer(req, res, () => { continued = true; });
  return { req, res, continued };
}

test('customer routes reject missing authentication', () => {
  const { res, continued } = invoke(null);
  assert.equal(res.statusCode, 401);
  assert.equal(continued, false);
});

test('customer routes reject owner and administrator tokens', () => {
  for (const role of ['owner', 'admin']) {
    const token = jwt.sign({ id: 12, role }, process.env.JWT_SECRET);
    const { res, continued } = invoke(token);
    assert.equal(res.statusCode, 403);
    assert.equal(continued, false);
  }
});

test('customer routes accept a signed-in customer token', () => {
  const token = jwt.sign({ id: 42, email: 'player@example.test' }, process.env.JWT_SECRET);
  const { req, res, continued } = invoke(token);
  assert.equal(res.statusCode, 200);
  assert.equal(req.user.id, 42);
  assert.equal(continued, true);
});
