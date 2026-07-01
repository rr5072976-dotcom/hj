/**
 * Gmail API routes — handles OAuth 2.0 flow, connection testing, and email sending.
 * Credentials and tokens are persisted as JSON files under .gmail-tester-data/
 * in the workspace root so they survive server restarts.
 */
import { Router, type Request, type Response } from "express";
import { google } from "googleapis";
import fs from "fs";
import path from "path";

const router = Router();

// ---------------------------------------------------------------------------
// Storage paths — always resolve to workspace root regardless of cwd
// ---------------------------------------------------------------------------

/** Walk up from cwd until we find pnpm-workspace.yaml (workspace root). */
function findWorkspaceRoot(): string {
  let dir = process.cwd();
  while (true) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd(); // reached fs root, fall back
    dir = parent;
  }
}

const STORAGE_DIR = path.join(findWorkspaceRoot(), ".gmail-tester-data");
const CREDENTIALS_FILE = path.join(STORAGE_DIR, "credentials.json");
const TOKEN_FILE = path.join(STORAGE_DIR, "token.json");

// Gmail scopes — send + readonly so we can verify the connection
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

// ---------------------------------------------------------------------------
// Log helpers
// ---------------------------------------------------------------------------
type LogLevel = "info" | "success" | "error" | "warning" | "debug";

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
}

function log(level: LogLevel, message: string): LogEntry {
  return { level, message, timestamp: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

/** Ensure the storage directory exists. */
function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }
}

/** Read and parse credentials JSON from disk, or return null. */
function loadCredentials(): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
  } catch {
    return null;
  }
}

/** Read and parse stored OAuth token from disk, or return null. */
function loadToken(): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Create a configured Google OAuth2 client from credentials.
 * Supports both "web" and "installed" credential types.
 * Pass redirectUriOverride to use a specific redirect URI instead of redirect_uris[0].
 */
function createOAuth2Client(credentials: Record<string, unknown>, redirectUriOverride?: string) {
  const cfg =
    (credentials.web as Record<string, unknown>) ||
    (credentials.installed as Record<string, unknown>);
  if (!cfg) throw new Error("Invalid credentials: missing 'web' or 'installed' key");
  const { client_id, client_secret, redirect_uris } = cfg as {
    client_id: string;
    client_secret: string;
    redirect_uris: string[];
  };
  const redirectUri = redirectUriOverride ?? redirect_uris[0];
  return new google.auth.OAuth2(client_id, client_secret, redirectUri);
}

/**
 * Return the redirect URI from the credentials file (redirect_uris[0]).
 * This is the value the user explicitly registered in Google Cloud Console,
 * so it will always match — no env-var guessing required.
 */
function getRedirectUri(credentials: Record<string, unknown>): string {
  const cfg =
    (credentials.web as Record<string, unknown>) ||
    (credentials.installed as Record<string, unknown>);
  const uris = cfg?.redirect_uris as string[] | undefined;
  if (!uris?.[0]) throw new Error("No redirect_uri found in credentials");
  return uris[0];
}

// ---------------------------------------------------------------------------
// HTML helper for the OAuth callback page
// ---------------------------------------------------------------------------
function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildCallbackHtml(success: boolean, message: string, logs: LogEntry[]): string {
  const color = success ? "#22c55e" : "#ef4444";
  const icon = success ? "✓" : "✗";
  const logsHtml = logs
    .map(
      (l) =>
        `<div class="log ${l.level}">[${l.level.toUpperCase()}] ${l.timestamp} — ${escapeHtml(l.message)}</div>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html>
<head>
  <title>Gmail Auth ${success ? "Success" : "Failed"}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; padding: 40px; max-width: 800px; margin: 0 auto; }
    .status { font-size: 64px; color: ${color}; text-align: center; margin: 24px 0; }
    .message { font-size: 20px; text-align: center; margin-bottom: 32px; }
    .logs { background: #1e293b; border-radius: 8px; padding: 20px; font-family: monospace; font-size: 13px; line-height: 1.8; white-space: pre-wrap; word-break: break-all; }
    .log.info    { color: #60a5fa; }
    .log.success { color: #4ade80; }
    .log.error   { color: #f87171; }
    .log.warning { color: #fbbf24; }
    .log.debug   { color: #94a3b8; }
    .btn { display: block; margin: 24px auto; padding: 12px 28px; background: #3b82f6; color: white; border: none; border-radius: 6px; font-size: 16px; cursor: pointer; text-align: center; text-decoration: none; width: fit-content; }
    h3 { color: #94a3b8; border-bottom: 1px solid #334155; padding-bottom: 8px; }
  </style>
</head>
<body>
  <div class="status">${icon}</div>
  <div class="message">${escapeHtml(message)}</div>
  <a class="btn" href="/">Return to App (close this tab)</a>
  <h3>Authentication Log</h3>
  <div class="logs">${logsHtml}</div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * POST /api/gmail/credentials
 * Accept the user's Google OAuth credentials JSON and persist it.
 */
router.post("/credentials", (req: Request, res: Response) => {
  const logs: LogEntry[] = [];
  try {
    logs.push(log("info", "Received credentials upload request"));
    logs.push(log("info", "Validating credentials structure..."));

    const { credentials } = req.body as { credentials?: Record<string, unknown> };
    if (!credentials) {
      logs.push(log("error", "Request body missing 'credentials' field"));
      res.status(400).json({ error: "credentials field is required", logs });
      return;
    }

    const cfg =
      (credentials.web as Record<string, unknown>) ||
      (credentials.installed as Record<string, unknown>);

    if (!cfg) {
      logs.push(log("error", "Invalid format — expected a 'web' or 'installed' key at root"));
      res.status(400).json({ error: "Invalid credentials: missing 'web' or 'installed' key", logs });
      return;
    }

    const { client_id, client_secret, redirect_uris } = cfg as Record<string, unknown>;
    if (!client_id || !client_secret || !redirect_uris) {
      logs.push(log("error", "Missing required fields: client_id, client_secret, redirect_uris"));
      res.status(400).json({ error: "Credentials missing required fields", logs });
      return;
    }

    logs.push(log("info", `Credential type : ${credentials.web ? "web" : "installed"}`));
    logs.push(log("info", `Client ID       : ${String(client_id)}`));
    logs.push(
      log("info", `Redirect URIs   : ${(redirect_uris as string[]).join(", ")}`),
    );

    ensureStorageDir();
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), "utf-8");
    logs.push(log("success", `Credentials saved to ${CREDENTIALS_FILE}`));

    res.json({ success: true, message: "Credentials loaded successfully", logs });
  } catch (err) {
    const e = err as Error;
    logs.push(log("error", `Unexpected exception: ${e.message}\n${e.stack ?? ""}`));
    res.status(500).json({ error: e.message, logs });
  }
});

/**
 * GET /api/gmail/auth/start
 * Generate a Google OAuth2 consent URL and return it to the frontend.
 */
router.get("/auth/start", (req: Request, res: Response) => {
  const logs: LogEntry[] = [];
  try {
    logs.push(log("info", "Initiating OAuth 2.0 authorization flow"));

    const credentials = loadCredentials();
    if (!credentials) {
      logs.push(log("error", "No credentials file found on disk"));
      res.status(400).json({ error: "No credentials loaded. Upload credentials first.", logs });
      return;
    }

    const callbackUri = getRedirectUri(credentials);
    const oauth2Client = createOAuth2Client(credentials, callbackUri);
    logs.push(log("info", "OAuth2 client created successfully"));

    logs.push(log("info", `Using redirect URI: ${callbackUri}`));
    logs.push(log("info", `Requesting scopes:`));
    SCOPES.forEach((s) => logs.push(log("info", `  → ${s}`)));

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: "offline",  // get refresh_token
      scope: SCOPES,
      prompt: "consent",       // always show consent to get fresh refresh_token
    });

    logs.push(log("info", "Authorization URL generated — awaiting user consent"));
    res.json({ authUrl, logs });
  } catch (err) {
    const e = err as Error;
    logs.push(log("error", `Exception: ${e.message}\n${e.stack ?? ""}`));
    res.status(500).json({ error: e.message, logs });
  }
});

/**
 * GET /api/gmail/auth/callback
 * Google redirects here after user grants (or denies) consent.
 * Exchanges the authorization code for tokens and persists them.
 */
router.get("/auth/callback", async (req: Request, res: Response) => {
  const logs: LogEntry[] = [];
  const { code, error } = req.query as { code?: string; error?: string };

  if (error) {
    logs.push(log("error", `Google returned an OAuth error: ${error}`));
    res.status(400).send(buildCallbackHtml(false, `OAuth denied: ${error}`, logs));
    return;
  }

  if (!code) {
    logs.push(log("error", "No authorization code in callback query string"));
    res.status(400).send(buildCallbackHtml(false, "No authorization code received", logs));
    return;
  }

  try {
    logs.push(log("info", "Callback received with authorization code"));
    logs.push(log("info", "Exchanging authorization code for access + refresh tokens..."));

    const credentials = loadCredentials();
    if (!credentials) {
      logs.push(log("error", "No credentials found on server"));
      res.status(400).send(buildCallbackHtml(false, "Server missing credentials", logs));
      return;
    }

    const oauth2Client = createOAuth2Client(credentials);
    const { tokens } = await oauth2Client.getToken(code);

    // Log token details (omit actual token values for security)
    logs.push(log("success", "Token exchange succeeded!"));
    logs.push(log("info", `Token type        : ${tokens.token_type ?? "bearer"}`));
    logs.push(log("info", `Access token      : ${tokens.access_token ? "obtained ✓" : "not present"}`));
    logs.push(log("info", `Refresh token     : ${tokens.refresh_token ? "obtained ✓" : "not present (may already exist)"}`));

    if (tokens.expiry_date) {
      const exp = new Date(tokens.expiry_date);
      logs.push(log("info", `Access token expires : ${exp.toISOString()}`));
    }

    if (tokens.scope) {
      logs.push(log("info", `Granted scopes:`));
      tokens.scope.split(" ").forEach((s) => logs.push(log("info", `  ✓ ${s}`)));
    }

    ensureStorageDir();
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), "utf-8");
    logs.push(log("success", `Token persisted to ${TOKEN_FILE}`));
    logs.push(log("success", "You will not need to sign in again until the refresh token is revoked."));

    res.send(buildCallbackHtml(true, "Authentication successful — token saved.", logs));
  } catch (err: unknown) {
    const e = err as Error & { response?: { status: number; data: unknown } };
    logs.push(log("error", `Token exchange failed: ${e.message}`));
    if (e.response) {
      logs.push(log("error", `HTTP ${e.response.status}: ${JSON.stringify(e.response.data, null, 2)}`));
    }
    logs.push(log("error", `Stack trace:\n${e.stack ?? ""}`));
    res.status(500).send(buildCallbackHtml(false, `Authentication failed: ${e.message}`, logs));
  }
});

/**
 * POST /api/gmail/auth/exchange
 * Called by the frontend /callback page after Google redirects with ?code=
 * Exchanges the authorization code for tokens and persists them.
 */
router.post("/auth/exchange", async (req: Request, res: Response) => {
  const logs: LogEntry[] = [];
  try {
    const { code } = req.body as { code?: string };
    if (!code) {
      logs.push(log("error", "Missing 'code' in request body"));
      res.status(400).json({ success: false, error: "code is required", logs });
      return;
    }

    logs.push(log("info", "Frontend delivered authorization code — starting token exchange"));

    const credentials = loadCredentials();
    if (!credentials) {
      logs.push(log("error", "No credentials found on server"));
      res.status(400).json({ success: false, error: "No credentials loaded. Upload credentials first.", logs });
      return;
    }

    // Must use the SAME redirect URI that was used when generating the auth URL
    const callbackUri = getRedirectUri(credentials);
    logs.push(log("info", `Redirect URI used for exchange: ${callbackUri}`));

    // --- Raw token exchange so we can see every detail Google returns ---
    const cfg =
      (credentials.web as Record<string, string>) ||
      (credentials.installed as Record<string, string>);

    const tokenEndpoint = cfg.token_uri ?? "https://oauth2.googleapis.com/token";
    const body = new URLSearchParams({
      code,
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      redirect_uri: callbackUri,
      grant_type: "authorization_code",
    });

    logs.push(log("info", `POSTing to token endpoint: ${tokenEndpoint}`));
    logs.push(log("info", `  client_id    : ${cfg.client_id}`));
    logs.push(log("info", `  redirect_uri : ${callbackUri}`));
    logs.push(log("info", `  grant_type   : authorization_code`));
    logs.push(log("info", `  code         : ${code.slice(0, 20)}...`));

    const rawResp = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    const rawJson = (await rawResp.json()) as Record<string, unknown>;

    if (!rawResp.ok || rawJson.error) {
      // Log the error details (no tokens present on error responses)
      logs.push(log("error", `Google token endpoint returned ${rawResp.status}: ${JSON.stringify(rawJson)}`));
      throw Object.assign(
        new Error(String(rawJson.error ?? "token_exchange_failed")),
        { response: { status: rawResp.status, data: rawJson } },
      );
    }
    // Never log token values — only log which fields are present
    const presentFields = Object.keys(rawJson).join(", ");
    logs.push(log("info", `Google response ${rawResp.status} OK — fields received: ${presentFields}`));

    const tokens = rawJson as {
      access_token?: string;
      refresh_token?: string;
      expiry_date?: number;
      expires_in?: number;
      scope?: string;
      token_type?: string;
    };
    if (tokens.expires_in && !tokens.expiry_date) {
      tokens.expiry_date = Date.now() + tokens.expires_in * 1000;
    }

    logs.push(log("success", "Token exchange succeeded!"));
    logs.push(log("info", `Access token  : ${tokens.access_token ? "obtained ✓" : "not present"}`));
    logs.push(log("info", `Refresh token : ${tokens.refresh_token ? "obtained ✓" : "not present (may already exist)"}`));

    if (tokens.expiry_date) {
      logs.push(log("info", `Access token expires: ${new Date(tokens.expiry_date).toISOString()}`));
    }
    if (tokens.scope) {
      logs.push(log("info", "Granted scopes:"));
      tokens.scope.split(" ").forEach((s) => logs.push(log("info", `  ✓ ${s}`)));
    }

    // Merge with any existing token — preserve refresh_token if new response omits it
    ensureStorageDir();
    const existing = loadToken() as Record<string, unknown> | null;
    const merged = { ...(existing ?? {}), ...(tokens as Record<string, unknown>) };
    if (!tokens.refresh_token && existing?.refresh_token) {
      merged.refresh_token = existing.refresh_token;
      logs.push(log("info", "Preserved existing refresh_token (not returned in this exchange)"));
    }

    fs.writeFileSync(TOKEN_FILE, JSON.stringify(merged, null, 2), "utf-8");
    logs.push(log("success", "Token persisted to disk — you are now authenticated."));

    res.json({ success: true, logs });
  } catch (err: unknown) {
    const e = err as Error & { response?: { status: number; data: unknown } };
    logs.push(log("error", `Token exchange failed: ${e.message}`));
    if (e.response) {
      logs.push(log("error", `HTTP ${e.response.status}: ${JSON.stringify(e.response.data, null, 2)}`));
    }
    logs.push(log("error", `Stack trace:\n${e.stack ?? ""}`));
    res.status(500).json({ success: false, error: e.message, logs });
  }
});

/**
 * GET /api/gmail/auth/status
 * Returns whether credentials and a valid token are present.
 */
router.get("/auth/status", (req: Request, res: Response) => {
  const logs: LogEntry[] = [];
  try {
    logs.push(log("info", "Checking authentication status..."));

    const hasCredentials = fs.existsSync(CREDENTIALS_FILE);
    logs.push(log(hasCredentials ? "info" : "warning", `Credentials file: ${hasCredentials ? "found" : "not found"}`));

    const token = loadToken() as { access_token?: string; expiry_date?: number } | null;
    const hasToken = !!token?.access_token;
    logs.push(log(hasToken ? "info" : "warning", `Token file: ${hasToken ? "found" : "not found"}`));

    let expiresAt: string | null = null;
    if (token?.expiry_date) {
      expiresAt = new Date(token.expiry_date).toISOString();
      const isExpired = token.expiry_date < Date.now();
      logs.push(
        log(
          isExpired ? "warning" : "info",
          `Token expiry: ${expiresAt} (${isExpired ? "EXPIRED — will attempt refresh" : "valid"})`,
        ),
      );
    }

    const authenticated = hasCredentials && hasToken;
    logs.push(log(authenticated ? "success" : "warning", `Status: ${authenticated ? "authenticated" : "not authenticated"}`));

    res.json({ authenticated, hasCredentials, email: null, expiresAt, logs });
  } catch (err) {
    const e = err as Error;
    logs.push(log("error", `Exception: ${e.message}\n${e.stack ?? ""}`));
    res.json({ authenticated: false, hasCredentials: false, email: null, expiresAt: null, logs });
  }
});

/**
 * DELETE /api/gmail/auth/logout
 * Removes the stored OAuth token from disk.
 */
router.delete("/auth/logout", (req: Request, res: Response) => {
  const logs: LogEntry[] = [];
  try {
    logs.push(log("info", "Processing logout request..."));

    if (fs.existsSync(TOKEN_FILE)) {
      fs.unlinkSync(TOKEN_FILE);
      logs.push(log("success", "Token file deleted from disk"));
    } else {
      logs.push(log("info", "No token file found — already logged out"));
    }

    res.json({ success: true, message: "Logged out successfully", logs });
  } catch (err) {
    const e = err as Error;
    logs.push(log("error", `Exception: ${e.message}\n${e.stack ?? ""}`));
    res.json({ success: false, message: e.message, logs });
  }
});

/**
 * GET /api/gmail/token-info
 * Returns the authenticated email address and granted scopes from the stored token.
 */
router.get("/token-info", async (req: Request, res: Response) => {
  const logs: LogEntry[] = [];
  try {
    logs.push(log("info", "Fetching token information..."));

    const credentials = loadCredentials();
    if (!credentials) {
      logs.push(log("error", "No credentials found on disk"));
      res.status(401).json({ error: "No credentials loaded. Upload credentials first.", logs });
      return;
    }

    const token = loadToken();
    if (!token) {
      logs.push(log("error", "No token found on disk — user must authenticate first"));
      res.status(401).json({ error: "Not authenticated. Please sign in first.", logs });
      return;
    }

    const oauth2Client = createOAuth2Client(credentials);
    oauth2Client.setCredentials(token as Parameters<typeof oauth2Client.setCredentials>[0]);

    logs.push(log("info", "Calling Google OAuth2 userinfo API..."));

    const oauth2Api = google.oauth2({ version: "v2", auth: oauth2Client });
    const userInfo = await oauth2Api.userinfo.get();

    const email = userInfo.data.email ?? "Unknown";
    logs.push(log("success", `Authenticated email address: ${email}`));

    const tokenData = token as { scope?: string; expiry_date?: number; token_type?: string; refresh_token?: string };
    const scopes = tokenData.scope ? tokenData.scope.split(" ") : [];
    logs.push(log("info", `Granted scopes (${scopes.length}):`));
    scopes.forEach((s) => logs.push(log("info", `  ✓ ${s}`)));

    let expiresAt: string | null = null;
    if (tokenData.expiry_date) {
      expiresAt = new Date(tokenData.expiry_date).toISOString();
      const isExpired = tokenData.expiry_date < Date.now();
      logs.push(log(isExpired ? "warning" : "info", `Token expiry: ${expiresAt} (${isExpired ? "EXPIRED" : "valid"})`));
    }

    logs.push(log("info", `Token type    : ${tokenData.token_type ?? "Bearer"}`));
    logs.push(log("info", `Refresh token : ${tokenData.refresh_token ? "present ✓" : "not present"}`));

    res.json({ email, scopes, expiresAt, tokenType: tokenData.token_type ?? "Bearer", logs });
  } catch (err: unknown) {
    const e = err as Error & { response?: { status: number; data: unknown } };
    logs.push(log("error", `Exception: ${e.message}`));
    if (e.response) {
      logs.push(log("error", `HTTP ${e.response.status}: ${JSON.stringify(e.response.data, null, 2)}`));
    }
    logs.push(log("error", `Stack trace:\n${e.stack ?? ""}`));
    res.status(401).json({ error: e.message, logs });
  }
});

/**
 * GET /api/gmail/test
 * Verifies Gmail API access by fetching the authenticated user's profile.
 */
router.get("/test", async (req: Request, res: Response) => {
  const logs: LogEntry[] = [];
  try {
    logs.push(log("info", "Starting Gmail API connection test..."));

    const credentials = loadCredentials();
    if (!credentials) {
      logs.push(log("error", "No credentials found"));
      res.json({ success: false, message: "No credentials loaded. Upload credentials first.", logs });
      return;
    }

    const token = loadToken();
    if (!token) {
      logs.push(log("error", "No token found — user must authenticate first"));
      res.json({ success: false, message: "Not authenticated. Please sign in first.", logs });
      return;
    }

    const oauth2Client = createOAuth2Client(credentials);
    oauth2Client.setCredentials(token as Parameters<typeof oauth2Client.setCredentials>[0]);

    logs.push(log("info", "Gmail API request: GET /gmail/v1/users/me/profile"));
    logs.push(log("debug", "Endpoint: https://gmail.googleapis.com/gmail/v1/users/me/profile"));

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const profileRes = await gmail.users.getProfile({ userId: "me" });

    logs.push(log("info", `HTTP Status: ${profileRes.status}`));

    const email = profileRes.data.emailAddress ?? "Unknown";
    const messagesTotal = profileRes.data.messagesTotal ?? null;

    logs.push(log("success", "Gmail API connection test PASSED"));
    logs.push(log("info", `Authenticated as: ${email}`));
    if (messagesTotal !== null) {
      logs.push(log("info", `Total messages in mailbox: ${messagesTotal.toLocaleString()}`));
    }

    res.json({ success: true, message: "Gmail API connection successful", details: { email, messagesTotal }, logs });
  } catch (err: unknown) {
    const e = err as Error & { response?: { status: number; statusText: string; data: unknown } };
    logs.push(log("error", `Connection test FAILED: ${e.message}`));
    if (e.response) {
      logs.push(log("error", `HTTP Status: ${e.response.status} ${e.response.statusText}`));
      logs.push(log("error", `Full error response (JSON):\n${JSON.stringify(e.response.data, null, 2)}`));
    }
    logs.push(log("error", `Full exception traceback:\n${e.stack ?? ""}`));
    res.json({ success: false, message: `Connection failed: ${e.message}`, logs });
  }
});

/**
 * POST /api/gmail/send
 * Builds a MIME email and sends it via the Gmail API users.messages.send endpoint.
 */
router.post("/send", async (req: Request, res: Response) => {
  const logs: LogEntry[] = [];
  let httpStatus = 500;

  try {
    logs.push(log("info", "Preparing Gmail API send request..."));

    const { from, to, subject, body } = req.body as {
      from?: string;
      to?: string;
      subject?: string;
      body?: string;
    };

    // Input validation
    const missing = ["from", "to", "subject", "body"].filter((k) => !req.body[k]);
    if (missing.length) {
      logs.push(log("error", `Missing required fields: ${missing.join(", ")}`));
      res.status(400).json({ error: `Missing fields: ${missing.join(", ")}`, logs });
      return;
    }

    logs.push(log("info", `From    : ${from}`));
    logs.push(log("info", `To      : ${to}`));
    logs.push(log("info", `Subject : ${subject}`));
    logs.push(log("info", `Body    : ${body!.length} characters`));

    const credentials = loadCredentials();
    if (!credentials) {
      logs.push(log("error", "No credentials found on disk"));
      res.status(401).json({ error: "No credentials loaded. Upload credentials first.", logs });
      return;
    }

    const token = loadToken();
    if (!token) {
      logs.push(log("error", "No token found — please authenticate first"));
      res.status(401).json({ error: "Not authenticated. Please sign in first.", logs });
      return;
    }

    const oauth2Client = createOAuth2Client(credentials);
    oauth2Client.setCredentials(token as Parameters<typeof oauth2Client.setCredentials>[0]);

    // Build RFC 2822 MIME message
    logs.push(log("info", "Building RFC 2822 MIME message..."));
    const mime = [
      `MIME-Version: 1.0`,
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Content-Type: text/plain; charset=utf-8`,
      ``,
      body,
    ].join("\r\n");

    // Base64url encode (Gmail API requirement)
    const raw = Buffer.from(mime)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    logs.push(log("info", `MIME message base64url-encoded (${raw.length} chars)`));
    logs.push(log("info", "Calling Gmail API: POST /gmail/v1/users/me/messages/send"));
    logs.push(log("debug", `Request body: { raw: "<${raw.length} chars of base64url>" }`));

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });
    const response = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });

    httpStatus = response.status;
    logs.push(log("info", `HTTP Status: ${response.status}`));
    logs.push(log("success", "Email sent successfully!"));
    logs.push(log("info", `Gmail Message ID : ${response.data.id}`));
    logs.push(log("info", `Thread ID        : ${response.data.threadId}`));

    res.json({ success: true, messageId: response.data.id, httpStatus, logs });
  } catch (err: unknown) {
    const e = err as Error & { response?: { status: number; statusText: string; data: unknown } };
    logs.push(log("error", `Send request FAILED: ${e.message}`));

    if (e.response) {
      httpStatus = e.response.status;
      logs.push(log("error", `HTTP Status: ${e.response.status} ${e.response.statusText}`));
      logs.push(log("error", `Complete JSON error response from Gmail API:\n${JSON.stringify(e.response.data, null, 2)}`));
    }

    logs.push(log("error", `Full Python-style exception traceback:\n${e.stack ?? e.message}`));

    res.status(httpStatus >= 400 ? httpStatus : 500).json({
      success: false,
      messageId: null,
      httpStatus,
      logs,
    });
  }
});

export default router;
