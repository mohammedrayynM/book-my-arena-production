const http = require('http');

const req = http.request({
  hostname: 'localhost',
  port: 5000,
  path: '/api/owners/register',
  method: 'OPTIONS',
  headers: {
    'Origin': 'http://localhost:3000',
    'Access-Control-Request-Method': 'POST'
  }
}, res => {
  console.log('Status:', res.statusCode);
  console.log('Headers:', res.headers);
});
req.on('error', error => console.error(error));
req.end();
