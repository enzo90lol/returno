// enhanced-passthrough-proxy.js - NBA 2K17 Pass-through Proxy
// This proxy forwards requests to real 2K servers while allowing monitoring and modification

const http = require('http');
const https = require('https');
const net = require('net');
const url = require('url');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  PROXY_PORT: 8080,
  LOCAL_SERVER_PORT: 49767, // Your local server for fallback/testing
  LOGS_DIR: './proxy_logs',
  ENABLE_REQUEST_LOGGING: true,
  ENABLE_RESPONSE_LOGGING: true,
  ENABLE_MODIFICATIONS: true,
  FALLBACK_TO_LOCAL: false, // Set to true to fallback to local server on errors
  CONNECTION_TIMEOUT: 30000, // 30 seconds
  REQUEST_TIMEOUT: 60000 // 60 seconds
};

// 2K Sports domains to intercept with correct ports
const INTERCEPT_DOMAINS = [
  'nba2k17-ws.2ksports.com',
  'nba2k17-services.2ksports.com', 
  'api.2ksports.com',
  'services.2ksports.com'
];

// Real 2K server endpoints mapping with correct ports
// Based on your server config, NBA 2K17 uses port 17217 for HTTPS
const SERVER_ENDPOINTS = {
  'nba2k17-ws.2ksports.com': { host: 'nba2k17-ws.2ksports.com', port: 17217, protocol: 'https' },
  'nba2k17-services.2ksports.com': { host: 'nba2k17-services.2ksports.com', port: 17217, protocol: 'https' },
  'api.2ksports.com': { host: 'api.2ksports.com', port: 17217, protocol: 'https' },
  'services.2ksports.com': { host: 'services.2ksports.com', port: 17217, protocol: 'https' }
};

// Ensure logs directory exists
if (!fs.existsSync(CONFIG.LOGS_DIR)) {
  fs.mkdirSync(CONFIG.LOGS_DIR, { recursive: true });
}

// Enhanced logging system
class ProxyLogger {
  constructor() {
    this.logFile = path.join(CONFIG.LOGS_DIR, `proxy-${new Date().toISOString().split('T')[0]}.log`);
    this.requestCounter = 0;
  }

  log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${level.toUpperCase()}: ${message}${data ? ' | ' + JSON.stringify(data, null, 2) : ''}\n`;
    
    console.log(logEntry.trim());
    
    if (CONFIG.ENABLE_REQUEST_LOGGING || CONFIG.ENABLE_RESPONSE_LOGGING) {
      fs.appendFileSync(this.logFile, logEntry);
    }
  }

  logRequest(requestId, method, originalUrl, targetUrl, headers, body) {
    if (CONFIG.ENABLE_REQUEST_LOGGING) {
      this.log('REQUEST', `[${requestId}] ${method} ${originalUrl} -> ${targetUrl}`, {
        headers: this.sanitizeHeaders(headers),
        body: this.sanitizeBody(body)
      });
    }
  }

  logResponse(requestId, statusCode, headers, body) {
    if (CONFIG.ENABLE_RESPONSE_LOGGING) {
      this.log('RESPONSE', `[${requestId}] ${statusCode}`, {
        headers: this.sanitizeHeaders(headers),
        body: this.sanitizeBody(body)
      });
    }
  }

  sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    // Remove sensitive headers but keep them for actual forwarding
    delete sanitized['authorization'];
    delete sanitized['cookie'];
    delete sanitized['x-session-token'];
    return sanitized;
  }

  sanitizeBody(body) {
    if (!body) return null;
    
    try {
      const parsed = JSON.parse(body);
      // Remove sensitive data for logging only
      delete parsed.password;
      delete parsed.token;
      delete parsed.sessionToken;
      return parsed;
    } catch {
      return body.length > 200 ? body.substring(0, 200) + '...' : body;
    }
  }

  generateRequestId() {
    return `REQ-${++this.requestCounter}-${Date.now()}`;
  }
}

const logger = new ProxyLogger();

// Request/Response modification functions
class RequestModifier {
  // Modify outgoing requests before sending to real servers
  static modifyRequest(requestId, method, path, headers, body) {
    if (!CONFIG.ENABLE_MODIFICATIONS) {
      return { path, headers, body };
    }

    // Example: Add custom headers
    const modifiedHeaders = { ...headers };
    modifiedHeaders['X-Proxy-Request-ID'] = requestId;
    modifiedHeaders['X-Proxy-Timestamp'] = new Date().toISOString();

    // Example: Modify specific endpoints
    if (path.includes('/user/login')) {
      logger.log('INFO', `[${requestId}] Intercepting login request`);
      // Could modify login data here if needed
    }

    return {
      path,
      headers: modifiedHeaders,
      body
    };
  }

  // Modify incoming responses before sending back to game
  static modifyResponse(requestId, statusCode, headers, body) {
    if (!CONFIG.ENABLE_MODIFICATIONS) {
      return { statusCode, headers, body };
    }

    // Example: Add custom response headers
    const modifiedHeaders = { ...headers };
    modifiedHeaders['X-Proxy-Response-ID'] = requestId;

    // Example: Modify specific response data
    try {
      const bodyData = JSON.parse(body);
      
      // Example: Boost VC balance in responses
      if (bodyData.vc !== undefined) {
        logger.log('INFO', `[${requestId}] Original VC balance: ${bodyData.vc}`);
        // bodyData.vc = Math.max(bodyData.vc, 10000); // Ensure minimum VC
      }
      
      return {
        statusCode,
        headers: modifiedHeaders,
        body: JSON.stringify(bodyData)
      };
    } catch {
      // Not JSON, return as-is
      return {
        statusCode,
        headers: modifiedHeaders,
        body
      };
    }
  }
}

// Main proxy request handler
function handleProxyRequest(req, res) {
  const requestId = logger.generateRequestId();
  const targetUrl = url.parse(req.url);
  const hostname = targetUrl.hostname || req.headers.host;
  
  logger.log('INFO', `[${requestId}] Incoming request: ${req.method} ${hostname}${targetUrl.path}`);
  
  // Check if this is a 2K Sports request
  if (INTERCEPT_DOMAINS.some(domain => hostname.includes(domain))) {
    logger.log('INFO', `[${requestId}] Intercepting 2K request for pass-through`);
    
    // Get the real server endpoint
    const serverConfig = SERVER_ENDPOINTS[hostname];
    if (!serverConfig) {
      logger.log('ERROR', `[${requestId}] No server configuration found for ${hostname}`);
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway: Unknown 2K server');
      return;
    }

    // Collect request body
    let requestBody = '';
    req.on('data', chunk => {
      requestBody += chunk.toString();
    });

    req.on('end', () => {
      // Log the original request
      logger.logRequest(requestId, req.method, `${hostname}${targetUrl.path}`, 
        `${serverConfig.protocol}://${serverConfig.host}:${serverConfig.port}${targetUrl.path}`, 
        req.headers, requestBody);

      // Modify request if needed
      const modified = RequestModifier.modifyRequest(requestId, req.method, targetUrl.path, req.headers, requestBody);

      // Forward to real 2K server
      forwardToRealServer(requestId, req.method, serverConfig, modified.path, modified.headers, modified.body, res);
    });

    req.on('error', (err) => {
      logger.log('ERROR', `[${requestId}] Request error: ${err.message}`);
      res.writeHead(500);
      res.end('Request Error');
    });
    
  } else {
    // Forward non-2K requests normally (standard HTTP proxy behavior)
    forwardNormalRequest(requestId, req, res);
  }
}

// Forward request to real 2K server
function forwardToRealServer(requestId, method, serverConfig, path, headers, body, clientRes) {
  const options = {
    hostname: serverConfig.host,
    port: serverConfig.port,
    path: path,
    method: method,
    headers: {
      ...headers,
      host: `${serverConfig.host}:${serverConfig.port}` // Important: Update the host header
    },
    timeout: CONFIG.REQUEST_TIMEOUT,
    // For HTTPS requests, we might need to ignore certificate errors during development
    rejectUnauthorized: false
  };

  logger.log('INFO', `[${requestId}] Forwarding to real server: ${serverConfig.protocol}://${serverConfig.host}:${serverConfig.port}${path}`);

  const httpModule = serverConfig.protocol === 'https' ? https : http;
  
  const proxyReq = httpModule.request(options, (proxyRes) => {
    logger.log('INFO', `[${requestId}] Real server response: ${proxyRes.statusCode}`);
    
    // Collect response body
    let responseBody = '';
    proxyRes.on('data', chunk => {
      responseBody += chunk.toString();
    });

    proxyRes.on('end', () => {
      // Log the response
      logger.logResponse(requestId, proxyRes.statusCode, proxyRes.headers, responseBody);

      // Modify response if needed
      const modified = RequestModifier.modifyResponse(requestId, proxyRes.statusCode, proxyRes.headers, responseBody);

      // Send response back to game
      clientRes.writeHead(modified.statusCode, modified.headers);
      clientRes.end(modified.body);
    });
  });

  proxyReq.on('error', (err) => {
    logger.log('ERROR', `[${requestId}] Real server error: ${err.message}`);
    
    if (CONFIG.FALLBACK_TO_LOCAL) {
      logger.log('INFO', `[${requestId}] Falling back to local server`);
      // Forward to local server instead
      forwardToLocalServer(requestId, method, path, headers, body, clientRes);
    } else {
      clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
      clientRes.end(`Bad Gateway: ${err.message}`);
    }
  });

  proxyReq.on('timeout', () => {
    logger.log('ERROR', `[${requestId}] Request timeout`);
    proxyReq.destroy();
    clientRes.writeHead(504, { 'Content-Type': 'text/plain' });
    clientRes.end('Gateway Timeout');
  });

  // Send the request body
  if (body) {
    proxyReq.write(body);
  }
  proxyReq.end();
}

// Fallback to local server if real server fails
function forwardToLocalServer(requestId, method, path, headers, body, clientRes) {
  const options = {
    hostname: '127.0.0.1',
    port: CONFIG.LOCAL_SERVER_PORT,
    path: path,
    method: method,
    headers: {
      ...headers,
      host: `127.0.0.1:${CONFIG.LOCAL_SERVER_PORT}`
    }
  };

  logger.log('INFO', `[${requestId}] Forwarding to local server: http://127.0.0.1:${CONFIG.LOCAL_SERVER_PORT}${path}`);

  const proxyReq = http.request(options, (proxyRes) => {
    logger.log('INFO', `[${requestId}] Local server response: ${proxyRes.statusCode}`);
    clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(clientRes);
  });

  proxyReq.on('error', (err) => {
    logger.log('ERROR', `[${requestId}] Local server error: ${err.message}`);
    clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
    clientRes.end(`Local Server Error: ${err.message}`);
  });

  if (body) {
    proxyReq.write(body);
  }
  proxyReq.end();
}

// Forward non-2K requests normally
function forwardNormalRequest(requestId, req, res) {
  const targetUrl = url.parse(req.url);
  const hostname = targetUrl.hostname;
  const port = targetUrl.port || 80;
  
  logger.log('INFO', `[${requestId}] Forwarding normal request: ${req.method} ${hostname}:${port}${targetUrl.path}`);
  
  const options = {
    hostname: hostname,
    port: port,
    path: targetUrl.path,
    method: req.method,
    headers: req.headers
  };
  
  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  
  proxyReq.on('error', (err) => {
    logger.log('ERROR', `[${requestId}] Normal request error: ${err.message}`);
    res.writeHead(500);
    res.end('Forward Error');
  });
  
  req.pipe(proxyReq);
}

// Handle HTTPS CONNECT method for SSL tunneling
function handleConnect(req, clientSocket, head) {
  const requestId = logger.generateRequestId();
  const [hostname, port] = req.url.split(':');
  const targetPort = parseInt(port) || 443;
  
  logger.log('INFO', `[${requestId}] HTTPS CONNECT: ${hostname}:${targetPort}`);
  
  // Check if this is a 2K Sports HTTPS request
  if (INTERCEPT_DOMAINS.some(domain => hostname.includes(domain))) {
    logger.log('INFO', `[${requestId}] Intercepting 2K HTTPS CONNECT for pass-through`);
    
    // For 2K requests, we need to establish a tunnel to the real server
    // Using the correct port (17217) instead of standard 443
    const realPort = 17217;
    
    logger.log('INFO', `[${requestId}] Establishing tunnel to real 2K server: ${hostname}:${realPort}`);
    
    const serverSocket = net.connect(realPort, hostname, () => {
      logger.log('INFO', `[${requestId}] Tunnel established to ${hostname}:${realPort}`);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      
      // Pipe data bidirectionally
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    
    serverSocket.on('error', (err) => {
      logger.log('ERROR', `[${requestId}] Tunnel error: ${err.message}`);
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.end();
    });
    
  } else {
    // Forward non-2K HTTPS requests normally
    logger.log('INFO', `[${requestId}] Forwarding normal HTTPS: ${hostname}:${targetPort}`);
    
    const serverSocket = net.connect(targetPort, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    
    serverSocket.on('error', (err) => {
      logger.log('ERROR', `[${requestId}] Normal HTTPS error: ${err.message}`);
      clientSocket.end();
    });
  }
}

// Create the proxy server
const proxy = http.createServer(handleProxyRequest);

// Handle HTTPS CONNECT method
proxy.on('connect', handleConnect);

// Start the proxy server
proxy.listen(CONFIG.PROXY_PORT, () => {
  logger.log('INFO', '🚀 NBA 2K17 Pass-Through Proxy Started');
  logger.log('INFO', `📡 Proxy listening on port ${CONFIG.PROXY_PORT}`);
  logger.log('INFO', `🎯 Intercepting domains: ${INTERCEPT_DOMAINS.join(', ')}`);
  logger.log('INFO', `🔗 Forwarding to real 2K servers on port 17217`);
  logger.log('INFO', `📁 Logs directory: ${CONFIG.LOGS_DIR}`);
  logger.log('INFO', `🔄 Fallback to local server: ${CONFIG.FALLBACK_TO_LOCAL ? 'ENABLED' : 'DISABLED'}`);
  
  console.log('\n🛠️  Setup Instructions:');
  console.log('1. Set system proxy to 127.0.0.1:8080');
  console.log('2. Ensure your firewall allows outbound connections to 2K servers');
  console.log('3. Launch NBA 2K17');
  console.log('4. Monitor logs for request/response traffic');
  console.log('\n⚙️  Configuration:');
  console.log(`- Request logging: ${CONFIG.ENABLE_REQUEST_LOGGING ? 'ON' : 'OFF'}`);
  console.log(`- Response logging: ${CONFIG.ENABLE_RESPONSE_LOGGING ? 'ON' : 'OFF'}`);
  console.log(`- Request modifications: ${CONFIG.ENABLE_MODIFICATIONS ? 'ON' : 'OFF'}`);
});

// Error handling
proxy.on('error', (err) => {
  logger.log('ERROR', `Proxy server error: ${err.message}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  logger.log('INFO', 'Shutting down proxy...');
  proxy.close(() => {
    logger.log('INFO', 'Proxy closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  logger.log('ERROR', `Uncaught exception: ${err.message}`, { stack: err.stack });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.log('ERROR', `Unhandled rejection: ${reason}`, { promise });
});