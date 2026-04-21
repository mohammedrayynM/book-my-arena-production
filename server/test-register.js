// Use global fetch (Node 18+)

async function testRegister() {
  const payload = {
    name: "Test Owner",
    email: `test_${Date.now()}@example.com`,
    phone: "1234567890",
    password: "password123"
  };

  try {
    const res = await fetch('http://localhost:5000/api/owners/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    console.log('Status:', res.status);
    console.log('Data:', data);
  } catch (err) {
    console.error('Fetch error:', err.message);
  }
}

testRegister();
