import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

const SUCCESS_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Authentication Successful</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    }
    .container {
      text-align: center;
      background: white;
      padding: 40px 60px;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
    }
    .checkmark {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      background: #4CAF50;
      margin: 0 auto 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .checkmark svg {
      width: 40px;
      height: 40px;
      fill: white;
    }
    h1 { color: #333; margin-bottom: 10px; }
    p { color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="checkmark">
      <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
    </div>
    <h1>Authentication Successful</h1>
    <p>You can close this window and return to the terminal.</p>
  </div>
</body>
</html>`;

const ERROR_HTML = (message: string) => `<!DOCTYPE html>
<html>
<head>
  <title>Authentication Failed</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%);
    }
    .container {
      text-align: center;
      background: white;
      padding: 40px 60px;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
    }
    .error-icon {
      width: 80px;
      height: 80px;
      border-radius: 50%;
      background: #f44336;
      margin: 0 auto 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .error-icon svg {
      width: 40px;
      height: 40px;
      fill: white;
    }
    h1 { color: #333; margin-bottom: 10px; }
    p { color: #666; }
    .error-message { color: #f44336; font-family: monospace; margin-top: 15px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="error-icon">
      <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
    </div>
    <h1>Authentication Failed</h1>
    <p>An error occurred during authentication.</p>
    <p class="error-message">${message}</p>
  </div>
</body>
</html>`;

export interface CallbackServerResult {
  code: string;
  shutdown: () => Promise<void>;
}

/**
 * Start a local HTTP server to receive the OAuth callback
 * @param port Port to listen on (default: 8085)
 * @param expectedState The state parameter we sent with the auth request
 * @param timeoutMs Timeout in milliseconds (default: 5 minutes)
 * @returns Promise that resolves with the authorization code
 */
export function startCallbackServer(
  port: number = 8085,
  expectedState: string,
  timeoutMs: number = 5 * 60 * 1000
): Promise<CallbackServerResult> {
  return new Promise((resolve, reject) => {
    // State object to hold mutable references
    const state: { timeoutHandle?: NodeJS.Timeout } = {};

    const createShutdown = (server: Server): (() => Promise<void>) => {
      return (): Promise<void> => {
        return new Promise((resolveShutdown) => {
          if (state.timeoutHandle) {
            clearTimeout(state.timeoutHandle);
          }
          server.close(() => resolveShutdown());
        });
      };
    };

    const handleRequest = (server: Server) => (req: IncomingMessage, res: ServerResponse) => {
      const shutdown = createShutdown(server);

      // Only handle the callback path
      if (!req.url?.startsWith('/auth/callback')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      const url = new URL(req.url, `http://localhost:${port}`);
      const code = url.searchParams.get('code');
      const reqState = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      const errorDescription = url.searchParams.get('error_description');

      // Handle error response from IdP
      if (error) {
        const message = errorDescription || error;
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML(message));
        shutdown().then(() => reject(new Error(`OAuth error: ${message}`)));
        return;
      }

      // Validate state parameter
      if (reqState !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML('Invalid state parameter. Possible CSRF attack.'));
        shutdown().then(() => reject(new Error('Invalid state parameter')));
        return;
      }

      // Validate code
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML('Missing authorization code'));
        shutdown().then(() => reject(new Error('Missing authorization code')));
        return;
      }

      // Success!
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(SUCCESS_HTML);
      resolve({ code, shutdown });
    };

    const server = createServer((req, res) => handleRequest(server)(req, res));

    server.on('error', (err) => {
      if (state.timeoutHandle) {
        clearTimeout(state.timeoutHandle);
      }
      reject(new Error(`Failed to start callback server: ${err.message}`));
    });

    // Listen only on localhost for security
    server.listen(port, '127.0.0.1', () => {
      const shutdown = createShutdown(server);
      // Set timeout
      state.timeoutHandle = setTimeout(() => {
        shutdown().then(() =>
          reject(new Error('Authentication timed out. No callback received within 5 minutes.'))
        );
      }, timeoutMs);
    });
  });
}

/**
 * Get the redirect URI for the callback server
 */
export function getRedirectUri(port: number = 8085): string {
  return `http://localhost:${port}/auth/callback`;
}
