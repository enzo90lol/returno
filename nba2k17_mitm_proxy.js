// mitm-proxy.js - Custom MITM proxy for NBA 2K17

const http = require('http');
const https = require('https');
const net = require('net');
const url = require('url');
const fs = require('fs');

// Configuration
const PROXY_PORT = 8080;
const LOCAL_SERVER_HOST = '127.0.0.1';
const LOCAL_SERVER_PORT = 49767;

// 2K Sports domains to intercept
const INTERCEPT_DOMAINS = [
  'nba2k17-ws.2ksports.com',
  'nba2k17-services.2ksports.com', 
  'api.2ksports.com',
  'services.2ksports.com',
  '2ksports.com'
];

// Load SSL certificates for HTTPS interception
let sslOptions = null;
try {
  sslOptions = {
    key: fs.readFileSync('nba2k17-ws.2ksports.com-key.pem'),
    cert: fs.readFileSync('nba2k17-ws.2ksports.com.pem')
  };
  console.log('✅ SSL certificates loaded for HTTPS interception');
} catch (error) {
  console.warn('⚠️ SSL certificates not found, HTTPS interception disabled');
}

// Create HTTP proxy server
const proxy = http.createServer((req, res) => {
  const targetUrl = url.parse(req.url);
  const hostname = targetUrl.hostname || req.headers.host;
  
  console.log(`🔍 HTTP Request: ${req.method} ${hostname}${targetUrl.path}`);
  
  // Check if this is a 2K Sports request
  if (INTERCEPT_DOMAINS.some(domain => hostname.includes(domain))) {
    console.log(`🎯 Intercepting 2K request: ${req.method} ${hostname}${targetUrl.path}`);
    
    // Redirect to local server
    const options = {
      hostname: LOCAL_SERVER_HOST,
      port: LOCAL_SERVER_PORT,
      path: targetUrl.path,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${LOCAL_SERVER_HOST}:${LOCAL_SERVER_PORT}`
      }
    };
    
    const proxyReq = http.request(options, (proxyRes) => {
      console.log(`📨 Local server response: ${proxyRes.statusCode}`);
      
      // Copy response headers
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      
      // Pipe response data
      proxyRes.pipe(res);
    });
    
    proxyReq.on('error', (err) => {
      console.error('❌ Proxy request error:', err);
      res.writeHead(500);
      res.end('Proxy Error');
    });
    
    // Pipe request data
    req.pipe(proxyReq);
    
  } else {
    // Forward non-2K requests normally
    console.log(`⏭️ Forwarding: ${req.method} ${hostname}${targetUrl.path}`);
    
    const options = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || 80,
      path: targetUrl.path,
      method: req.method,
      headers: req.headers
    };
    
    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    
    proxyReq.on('error', (err) => {
      console.error('❌ Forward request error:', err);
      res.writeHead(500);
      res.end('Forward Error');
    });
    
    req.pipe(proxyReq);
  }
});

// Handle HTTPS CONNECT method
proxy.on('connect', (req, clientSocket, head) => {
  const hostname = req.url.split(':')[0];
  const port = parseInt(req.url.split(':')[1]) || 443;
  
  console.log(`🔒 HTTPS CONNECT: ${hostname}:${port}`);
  
  // Check if this is a 2K Sports HTTPS request
  if (INTERCEPT_DOMAINS.some(domain => hostname.includes(domain))) {
    console.log(`🎯 Intercepting HTTPS 2K request: ${hostname}:${port}`);
    
    if (sslOptions) {
      // Create SSL server for interception
      const sslServer = https.createServer(sslOptions, (req, res) => {
        console.log(`🔍 HTTPS Request: ${req.method} ${hostname}${req.url}`);
        
        // Redirect to local server (HTTP)
        const options = {
          hostname: LOCAL_SERVER_HOST,
          port: LOCAL_SERVER_PORT,
          path: req.url,
          method: req.method,
          headers: {
            ...req.headers,
            host: `${LOCAL_SERVER_HOST}:${LOCAL_SERVER_PORT}`
          }
        };
        
        const proxyReq = http.request(options, (proxyRes) => {
          console.log(`📨 Local server response: ${proxyRes.statusCode}`);
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
        });
        
        proxyReq.on('error', (err) => {
          console.error('❌ HTTPS proxy request error:', err);
          res.writeHead(500);
          res.end('HTTPS Proxy Error');
        });
        
        req.pipe(proxyReq);
      });
      
      // Handle the SSL connection
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      sslServer.emit('connection', clientSocket);
      
    } else {
      // No SSL certificates, reject HTTPS interception
      console.log('❌ Cannot intercept HTTPS without SSL certificates');
      clientSocket.write('HTTP/1.1 500 SSL Interception Not Available\r\n\r\n');
      clientSocket.end();
    }
    
  } else {
    // Forward non-2K HTTPS requests normally
    console.log(`⏭️ Forwarding HTTPS: ${hostname}:${port}`);
    
    const serverSocket = net.connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    
    serverSocket.on('error', (err) => {
      console.error('❌ HTTPS forward error:', err);
      clientSocket.end();
    });
  }
});

// Start the proxy server
proxy.listen(PROXY_PORT, () => {
  console.log(`🚀 MITM Proxy running on port ${PROXY_PORT}`);
  console.log(`🎯 Intercepting domains: ${INTERCEPT_DOMAINS.join(', ')}`);
  console.log(`📡 Redirecting to: ${LOCAL_SERVER_HOST}:${LOCAL_SERVER_PORT}`);
  console.log('');
  console.log('Setup Instructions:');
  console.log('1. Set system proxy to 127.0.0.1:8080');
  console.log('2. Install SSL certificate if intercepting HTTPS');
  console.log('3. Start your local 2K17 server');
  console.log('4. Launch NBA 2K17');
});

// Error handling
proxy.on('error', (err) => {
  console.error('💥 Proxy server error:', err);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down proxy...');
  proxy.close(() => {
    console.log('✅ Proxy closed');
    process.exit(0);
  });
});
